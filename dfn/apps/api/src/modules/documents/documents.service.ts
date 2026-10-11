import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import {
  globalRoleHas,
  ErrorCode,
  Permission,
  TransactionEventType,
  type DocumentMetadataInput,
} from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { sha256Hex } from '../../common/crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RiskService } from '../risk/risk.service';
import { TransactionAccessService } from '../transactions/transaction-access.service';
import { TransactionEventsService } from '../transactions/transaction-events.service';
import { DocumentStorageService } from './storage.service';

const ALLOWED: Record<string, { ext: string[]; magic: (b: Buffer) => boolean }> = {
  'application/pdf': { ext: ['pdf'], magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': { ext: ['jpg', 'jpeg'], magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    ext: ['png'],
    magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    ext: ['webp'],
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorageService,
    private readonly audit: AuditService,
    private readonly organizations: OrganizationsService,
    private readonly access: TransactionAccessService,
    private readonly events: TransactionEventsService,
    private readonly risk: RiskService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  validateFile(file: UploadedFile) {
    if (!file || !file.buffer?.length) throw DomainError.validation('A file is required');
    if (file.size > this.env.MAX_UPLOAD_MB * 1024 * 1024) {
      throw new DomainError(
        ErrorCode.UNSUPPORTED_FILE,
        `File exceeds ${this.env.MAX_UPLOAD_MB} MB`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }
    const rule = ALLOWED[file.mimetype];
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (!rule || !rule.ext.includes(ext) || !rule.magic(file.buffer)) {
      throw new DomainError(
        ErrorCode.UNSUPPORTED_FILE,
        'Only PDF, JPEG, PNG and WebP files are accepted',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
  }

  async upload(auth: AuthContext, file: UploadedFile, meta: DocumentMetadataInput, req: Request) {
    this.validateFile(file);
    let organizationId: string;
    let transactionId: string | null = null;
    if (meta.transactionId) {
      const { tx, role } = await this.access.loadFor(auth, meta.transactionId);
      if (role === 'STAFF') throw DomainError.forbidden('Staff cannot upload documents on behalf of parties');
      if (['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'].includes(tx.status))
        throw DomainError.invalidTransition('Transaction is closed');
      organizationId =
        role === 'BUYER'
          ? tx.buyerOrganizationId
          : (tx.sellerOrganizationId ?? this.organizations.resolveActingOrganization(auth).organizationId);
      transactionId = tx.id;
    } else {
      organizationId = this.organizations.resolveActingOrganization(
        auth,
        meta.organizationId,
        Permission.DOCUMENT_UPLOAD,
      ).organizationId;
    }
    const sha256 = sha256Hex(file.buffer);
    const storageKey = `${organizationId}/${randomUUID()}`;
    const stored = await this.storage.put(storageKey, file.buffer);
    const safeName = file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 140);
    const requestMeta_ = requestMeta(req);
    const doc = await this.prisma
      .$transaction(async (db) => {
        const created = await db.document.create({
          data: {
            organizationId,
            uploadedByUserId: auth.userId,
            transactionId,
            kind: meta.kind,
            title: meta.title ?? safeName,
            fileName: safeName,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            sha256,
            storageKey,
            encrypted: true,
            storageDriver: stored.storageDriver,
            encryptionKeyId: stored.encryptionKeyId,
            retentionUntil: new Date(Date.now() + 7 * 365 * 86_400_000),
          },
        });
        if (transactionId) {
          await this.events.record(
            transactionId,
            TransactionEventType.DOCUMENT_UPLOADED,
            auth.userId,
            { documentId: created.id, kind: meta.kind, title: created.title },
            db,
          );
        }
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId,
            action: 'document.uploaded',
            entityType: 'Document',
            entityId: created.id,
            metadata: {
              kind: meta.kind,
              sizeBytes: file.size,
              sha256,
              transactionId,
              storageDriver: stored.storageDriver,
              encryptionKeyId: stored.encryptionKeyId,
            },
            ...requestMeta_,
          },
          db,
        );
        return created;
      })
      .catch(async (err: unknown) => {
        // The row was not written: do not leave an orphan blob behind.
        await this.storage.remove({ storageKey, storageDriver: stored.storageDriver });
        throw err;
      });
    if (transactionId) {
      const duplicates = await this.prisma.document.count({
        where: { sha256, transactionId: { not: transactionId }, deletedAt: null },
      });
      if (duplicates > 0) {
        await this.risk.evaluateAndRecord({
          event: 'document.uploaded',
          userId: auth.userId,
          organizationId,
          transactionId,
          documentSha256DuplicateCount: duplicates,
        });
      }
    }
    return this.toDto(doc);
  }

  toDto(doc: {
    id: string;
    organizationId: string;
    transactionId: string | null;
    kind: string;
    title: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    status: string;
    reviewNote: string | null;
    createdAt: Date;
    uploadedByUserId: string;
  }) {
    return {
      id: doc.id,
      organizationId: doc.organizationId,
      transactionId: doc.transactionId,
      kind: doc.kind,
      title: doc.title,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      sha256: doc.sha256,
      status: doc.status,
      reviewNote: doc.reviewNote,
      uploadedByUserId: doc.uploadedByUserId,
      createdAt: doc.createdAt,
      downloadUrl: `/api/v1/documents/${doc.id}/download`,
    };
  }

  private async canAccess(
    auth: AuthContext,
    doc: { organizationId: string; transactionId: string | null; uploadedByUserId: string },
  ) {
    if (isStaff(auth)) return true;
    if (doc.uploadedByUserId === auth.userId) return true;
    if (membershipFor(auth, doc.organizationId)) return true;
    if (doc.transactionId) {
      const tx = await this.access.load(doc.transactionId);
      return this.access.roleFor(auth, tx) !== null;
    }
    return false;
  }

  async listForTransaction(auth: AuthContext, transactionId: string) {
    await this.access.loadFor(auth, transactionId);
    const docs = await this.prisma.document.findMany({
      where: { transactionId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return docs.map((d) => this.toDto(d));
  }

  async listMine(auth: AuthContext, organizationId?: string) {
    const orgIds = organizationId ? [organizationId] : auth.memberships.map((m) => m.organizationId);
    if (organizationId && !isStaff(auth) && !membershipFor(auth, organizationId))
      throw DomainError.notFound('Organization');
    const docs = await this.prisma.document.findMany({
      where: { deletedAt: null, OR: [{ organizationId: { in: orgIds } }, { uploadedByUserId: auth.userId }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { transaction: { select: { id: true, reference: true, title: true } } },
    });
    return docs.map((d) => ({ ...this.toDto(d), transaction: d.transaction }));
  }

  async download(auth: AuthContext, id: string, req: Request) {
    const doc = await this.prisma.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc || !(await this.canAccess(auth, doc))) throw DomainError.notFound('Document');
    // Decrypts with the recorded key and re-checks the SHA-256: never serves corrupted content.
    const bytes = await this.storage.read(doc, auth.userId);
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId: doc.organizationId,
      action: 'document.downloaded',
      entityType: 'Document',
      entityId: doc.id,
      ...requestMeta(req),
    });
    return { doc, bytes };
  }

  async review(
    auth: AuthContext,
    id: string,
    decision: 'ACCEPT' | 'REJECT',
    note: string | undefined,
    req: Request,
  ) {
    const doc = await this.prisma.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc) throw DomainError.notFound('Document');
    const status = decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    const updated = await this.prisma.$transaction(async (db) => {
      const u = await db.document.update({
        where: { id },
        data: { status, reviewedById: auth.userId, reviewNote: note ?? null, reviewedAt: new Date() },
      });
      if (doc.transactionId)
        await this.events.record(
          doc.transactionId,
          TransactionEventType.DOCUMENT_REVIEWED,
          auth.userId,
          { documentId: id, status, note },
          db,
        );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: doc.organizationId,
          action: 'document.reviewed',
          entityType: 'Document',
          entityId: id,
          metadata: { status },
          ...requestMeta(req),
        },
        db,
      );
      return u;
    });
    return this.toDto(updated);
  }

  async softDelete(auth: AuthContext, id: string, req: Request) {
    const doc = await this.prisma.document.findFirst({ where: { id, deletedAt: null } });
    if (!doc) throw DomainError.notFound('Document');
    // The uploader may delete their own document; staff need the support-write permission (ADMIN):
    // reading tenant data never implies the right to destroy it.
    if (
      doc.uploadedByUserId !== auth.userId &&
      !globalRoleHas(auth.globalRole, Permission.ADMIN_SUPPORT_WRITE)
    ) {
      throw DomainError.forbidden();
    }
    const used = await this.prisma.evidence.count({ where: { documentId: id } });
    if (used > 0) throw DomainError.conflict('Document is attached as evidence and cannot be deleted');
    await this.prisma.document.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.storage.remove(doc);
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId: doc.organizationId,
      action: 'document.deleted',
      entityType: 'Document',
      entityId: id,
      ...requestMeta(req),
    });
    return { deleted: true };
  }
}
