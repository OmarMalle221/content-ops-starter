import {
    ALLOWED_MIME_TYPES,
    compareReferences,
    defaultVisibility,
    sanitizeFileName,
    sniffMimeType,
    UPLOAD_PERMISSIONS
} from '@/domain/documents';
import { parseMoney, toDTO, type CurrencyCode } from '@/domain/money';
import type { Document, ExtractedReferences } from '@/domain/model';
import { isTerminal } from '@/domain/transaction/state-machine';
import { documentReviewSchema, uploadDocumentSchema } from '@/lib/validation/schemas';
import type { Db } from '@/server/ports/db';
import type { Actor } from '@/server/auth/actor';
import { hasRole } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { sha256Hex } from '@/server/security/crypto';
import { signDocumentUrl, verifyDocumentUrl } from '@/server/security/signed-url';
import { accessTransaction, audit, notify, securitySettings, type Deps } from './context';
import type { RiskService } from './risk-service';

export interface UploadedFile {
    bytes: Uint8Array;
    fileName: string;
    declaredMimeType: string;
}

/** Staff roles allowed to open document contents (auditors only see metadata). */
const CONTENT_STAFF = ['document_reviewer', 'compliance_analyst', 'dispute_manager'] as const;

export class DocumentService {
    /** Set by the container: attaches an uploaded document to a milestone as evidence. */
    attachEvidence?: (db: Db, actor: Actor, transactionId: string, milestoneId: string, documentId: string) => Promise<void>;

    constructor(
        private readonly deps: Deps,
        private readonly risk: RiskService
    ) {}

    async upload(actor: Actor, rawInput: unknown, file: UploadedFile): Promise<Document> {
        const parsed = uploadDocumentSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid document metadata', { issues: parsed.error.issues });
        const input = parsed.data;
        const sniffed = sniffMimeType(file.bytes);
        if (!sniffed) throw new AppError('VALIDATION', `Unsupported file type. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`);
        if (file.declaredMimeType && file.declaredMimeType !== sniffed)
            throw new AppError('VALIDATION', 'File content does not match its declared type');
        // Scanning happens before anything is persisted.
        const scan = await this.deps.scanner.scan(file.bytes);

        const extracted: ExtractedReferences = {};
        const e = input.extracted;
        for (const k of [
            'vin',
            'ownerName',
            'consignee',
            'shipper',
            'portOfLoading',
            'portOfDischarge',
            'documentNumber',
            'issueDate'
        ] as const) {
            if (e[k]) extracted[k] = e[k];
        }
        if (e.amount) {
            try {
                extracted.amount = toDTO(parseMoney(e.amount, (e.amountCurrency ?? 'CAD') as CurrencyCode));
            } catch {
                throw new AppError('VALIDATION', 'Invalid declared amount');
            }
        }

        const checkUpload = async (db: Db) => {
            const settings = await securitySettings(db);
            if (file.bytes.byteLength > settings.maxUploadBytes)
                throw new AppError('VALIDATION', `File exceeds ${settings.maxUploadBytes} bytes`);
            if (file.bytes.byteLength === 0) throw new AppError('VALIDATION', 'Empty file');
            const { tx, party } = await accessTransaction(db, actor, input.transactionId, { write: true });
            if (isTerminal(tx.status)) throw new AppError('PRECONDITION_FAILED', 'The transaction is closed');
            if (!UPLOAD_PERMISSIONS[party!.role].includes(input.type))
                throw forbidden(`A ${party!.role} cannot upload ${input.type} documents`);
            return { tx, party: party! };
        };

        // The object is written to storage BEFORE the unit of work, after the same authorisation checks:
        // no database lock is held during the network upload, and a retried unit of work never uploads
        // twice. Its key is unique to this upload (document id + content hash), so a unit of work that
        // fails afterwards only leaves an unreferenced private object.
        const id = this.deps.ids.id();
        const sha256 = sha256Hex(file.bytes);
        const { tx: checked } = await this.deps.uow.run(checkUpload);
        const storageKey = `${checked.id}/${id}/${sha256}`;
        if (scan !== 'INFECTED') await this.deps.storage.put(storageKey, file.bytes, sniffed);

        return this.deps.uow.run(async (db) => {
            const { tx, party } = await checkUpload(db);
            if (tx.id !== checked.id) throw notFound('Transaction');

            let logicalId = this.deps.ids.id();
            let version = 1;
            if (input.replacesDocumentId) {
                const previous = await db.documents.get(input.replacesDocumentId);
                if (!previous || previous.transactionId !== tx.id || previous.type !== input.type) throw notFound('Document to replace');
                if (previous.ownerUserId !== actor.userId) throw forbidden('Only the original uploader can publish a new version');
                const versions = await db.documents.findBy({ logicalId: previous.logicalId });
                logicalId = previous.logicalId;
                version = Math.max(...versions.map((v) => v.version)) + 1;
                for (const v of versions) if (v.status !== 'SUPERSEDED') await db.documents.update(v.id, { status: 'SUPERSEDED' });
            }
            const now = this.deps.clock.now().toISOString();
            const doc: Document = {
                id,
                logicalId,
                version,
                transactionId: tx.id,
                ownerUserId: actor.userId,
                type: input.type,
                title: input.title,
                fileName: sanitizeFileName(file.fileName),
                mimeType: sniffed,
                sizeBytes: file.bytes.byteLength,
                sha256,
                storageKey,
                status: scan === 'CLEAN' ? 'PENDING_REVIEW' : scan === 'INFECTED' ? 'QUARANTINED' : 'SCAN_PENDING',
                visibleToRoles: defaultVisibility(input.type, party.role),
                extracted,
                extractionSource: Object.keys(extracted).length ? 'DECLARED' : 'NONE',
                scan: { status: scan, engine: this.deps.scanner.engine, scannedAt: now },
                uploadedAt: now
            };
            await db.documents.insert(doc);
            await audit(
                this.deps,
                db,
                actor,
                scan === 'INFECTED' ? 'document.quarantined' : 'document.uploaded',
                { type: 'document', id },
                {
                    transactionId: tx.id,
                    metadata: { type: doc.type, version, sha256, sizeBytes: doc.sizeBytes, scan }
                }
            );
            if (scan === 'INFECTED') return doc;
            if (input.milestoneId) await this.attachEvidence?.(db, actor, tx.id, input.milestoneId, id);
            for (const p of await db.transactionParties.findBy({ transactionId: tx.id })) {
                if (p.userId && p.userId !== actor.userId && doc.visibleToRoles.includes(p.role)) {
                    await notify(this.deps, db, p.userId, 'document.uploaded', { reference: tx.reference, type: doc.type }, tx.id);
                }
            }
            await this.risk.evaluateInTx(db, tx.id);
            return doc;
        });
    }

    /** Authorisation for document content. Never relies on the URL alone. */
    async canView(db: Db, actor: Actor, doc: Document): Promise<boolean> {
        if (doc.ownerUserId === actor.userId) return true;
        if (doc.type === 'IDENTITY') return hasRole(actor, 'compliance_analyst');
        if (hasRole(actor, ...CONTENT_STAFF)) return true;
        if (!doc.transactionId) return false;
        const party = (await db.transactionParties.findBy({ transactionId: doc.transactionId })).find(
            (p) => p.userId === actor.userId && p.status === 'JOINED'
        );
        return Boolean(party && doc.visibleToRoles.includes(party.role));
    }

    async listForTransaction(actor: Actor, transactionId: string) {
        return this.deps.uow.run(async (db) => {
            await accessTransaction(db, actor, transactionId);
            const docs = await db.documents.findBy({ transactionId });
            const visible: Document[] = [];
            for (const d of docs) if ((await this.canView(db, actor, d)) || hasRole(actor, 'auditor')) visible.push(d);
            return visible.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
        });
    }

    /** Denials are written in their own unit of work so they survive the failing request. */
    private async logDenied(actor: Actor, documentId: string, transactionId?: string) {
        await this.deps.uow.run(async (db) => {
            await db.documentAccessLogs.insert({
                id: this.deps.ids.id(),
                documentId,
                userId: actor.userId,
                action: 'DENIED',
                at: this.deps.clock.now().toISOString()
            });
            await audit(this.deps, db, actor, 'document.access_denied', { type: 'document', id: documentId }, { transactionId });
        });
    }

    async issueSignedUrl(actor: Actor, documentId: string): Promise<{ url: string; expiresAt: string }> {
        const result = await this.deps.uow.run(async (db) => {
            const doc = await db.documents.get(documentId);
            if (!doc) throw notFound('Document');
            const now = this.deps.clock.now();
            if (!(await this.canView(db, actor, doc))) return { denied: true as const, transactionId: doc.transactionId };
            if (doc.status === 'QUARANTINED' || doc.scan.status !== 'CLEAN')
                throw new AppError('PRECONDITION_FAILED', 'Document unavailable (security scan)');
            const settings = await securitySettings(db);
            const exp = Math.floor(now.getTime() / 1000) + settings.signedUrlTtlSeconds;
            await db.documentAccessLogs.insert({
                id: this.deps.ids.id(),
                documentId,
                userId: actor.userId,
                action: 'SIGNED_URL_ISSUED',
                at: now.toISOString()
            });
            return {
                denied: false as const,
                url: signDocumentUrl(this.deps.config.sessionSecret, documentId, actor.userId, exp),
                expiresAt: new Date(exp * 1000).toISOString()
            };
        });
        if (result.denied) {
            await this.logDenied(actor, documentId, result.transactionId);
            throw notFound('Document');
        }
        return { url: result.url, expiresAt: result.expiresAt };
    }

    async readContent(actor: Actor, documentId: string, exp: string | null, sig: string | null) {
        const now = this.deps.clock.now();
        const signatureValid = verifyDocumentUrl(
            this.deps.config.sessionSecret,
            documentId,
            actor.userId,
            exp,
            sig,
            Math.floor(now.getTime() / 1000)
        );
        const doc = await this.deps.uow
            .run(async (db) => {
                const d = await db.documents.get(documentId);
                if (!d) return { kind: 'missing' as const };
                if (!signatureValid || !(await this.canView(db, actor, d)))
                    return { kind: 'denied' as const, transactionId: d.transactionId };
                await db.documentAccessLogs.insert({
                    id: this.deps.ids.id(),
                    documentId,
                    userId: actor.userId,
                    action: 'DOWNLOAD',
                    at: now.toISOString()
                });
                return { kind: 'ok' as const, doc: d };
            })
            .then(async (r) => {
                if (r.kind === 'ok') return r.doc;
                if (r.kind === 'denied') await this.logDenied(actor, documentId, r.transactionId);
                throw notFound('Document');
            });
        const bytes = await this.deps.storage.get(doc.storageKey);
        if (!bytes) throw notFound('Document content');
        if (sha256Hex(bytes) !== doc.sha256)
            throw new AppError('CONFLICT', 'Integrity check failed: stored file does not match its recorded hash');
        return { bytes, mimeType: doc.mimeType, fileName: doc.fileName };
    }

    async review(actor: Actor, documentId: string, rawInput: unknown) {
        if (!hasRole(actor, 'document_reviewer')) throw forbidden();
        const parsed = documentReviewSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid review', { issues: parsed.error.issues });
        return this.deps.uow.run(async (db) => {
            const doc = await db.documents.get(documentId);
            if (!doc) throw notFound('Document');
            if (doc.status !== 'PENDING_REVIEW') throw new AppError('CONFLICT', 'Document is not awaiting review');
            if (doc.ownerUserId === actor.userId) throw forbidden('You cannot review your own document');
            const now = this.deps.clock.now().toISOString();
            await db.documentVerifications.insert({
                id: this.deps.ids.id(),
                documentId,
                reviewerId: actor.userId,
                decision: parsed.data.decision,
                notes: parsed.data.notes,
                createdAt: now
            });
            const status =
                parsed.data.decision === 'VERIFIED' ? 'VERIFIED' : parsed.data.decision === 'REJECTED' ? 'REJECTED' : 'PENDING_REVIEW';
            const updated = await db.documents.update(documentId, { status });
            await audit(
                this.deps,
                db,
                actor,
                'document.reviewed',
                { type: 'document', id: documentId },
                { transactionId: doc.transactionId, metadata: { decision: parsed.data.decision } }
            );
            await notify(
                this.deps,
                db,
                doc.ownerUserId,
                'document.reviewed',
                { decision: parsed.data.decision, title: doc.title },
                doc.transactionId
            );
            if (doc.transactionId) await this.risk.evaluateInTx(db, doc.transactionId);
            return updated;
        });
    }

    async comparison(actor: Actor, transactionId: string) {
        return this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId);
            const vehicle = await db.vehicles.findOne({ transactionId });
            const parties = await db.transactionParties.findBy({ transactionId });
            const names = async (role: 'SELLER' | 'BUYER') => {
                const p = parties.find((x) => x.role === role);
                const u = p?.userId ? await db.users.get(p.userId) : undefined;
                const o = p?.organizationId ? await db.organizations.get(p.organizationId) : undefined;
                return [p?.displayName, u?.fullName, o?.legalName].filter((x): x is string => Boolean(x));
            };
            const corridor = await db.corridors.get(tx.corridorId);
            const docs = [];
            for (const d of await db.documents.findBy({ transactionId })) {
                if (d.status !== 'SUPERSEDED' && d.status !== 'QUARANTINED' && (await this.canView(db, actor, d))) docs.push(d);
            }
            return {
                rows: compareReferences(
                    {
                        vin: vehicle?.vin,
                        sellerNames: await names('SELLER'),
                        buyerNames: await names('BUYER'),
                        amountMinor: tx.amount.amountMinor.toString(),
                        currency: tx.amount.currency,
                        dischargePorts: corridor?.expectedDischargePorts ?? []
                    },
                    docs
                ),
                documents: docs.map((d) => ({
                    id: d.id,
                    type: d.type,
                    title: d.title,
                    status: d.status,
                    extractionSource: d.extractionSource
                }))
            };
        });
    }

    async accessLog(actor: Actor, documentId: string) {
        if (!hasRole(actor, 'compliance_analyst', 'auditor', 'document_reviewer')) throw forbidden();
        return this.deps.uow.run(async (db) => db.documentAccessLogs.findBy({ documentId }));
    }
}
