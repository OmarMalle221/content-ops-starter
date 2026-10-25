import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma } from '@dfn/database';
import { randomToken } from '../../common/crypto';
import { KeyPurpose } from '@dfn/shared';
import { sealString } from '../../common/keyring';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import {
  ANONYMIZED_ACCOUNT_IDENTIFIER,
  ANONYMIZED_ACCOUNT_IDENTIFIER_MASKED,
  ANONYMIZED_BENEFICIARY_NAME,
  ANONYMIZED_COUNTERPARTY_NAME,
  ANONYMIZED_DECLARED_DATA,
  ANONYMIZED_ORGANIZATION_NAME,
  buildAnonymizedUser,
} from './anonymization';

export interface AnonymizationOutcome {
  userId: string;
  anonymizedAt: Date;
  alreadyAnonymized: boolean;
  sessionsRevoked: number;
  verificationsAnonymized: number;
  documentsMarkedDeleted: number;
  organizationsRenamed: number;
  beneficiariesAnonymized: number;
  counterpartiesAnonymized: number;
  customerEmailsCleared: number;
  passkeysDeleted: number;
  recoveryCodesDeleted: number;
  linkRequestsRevoked: number;
}

const EMPTY_OUTCOME = {
  passkeysDeleted: 0,
  recoveryCodesDeleted: 0,
  linkRequestsRevoked: 0,
  sessionsRevoked: 0,
  verificationsAnonymized: 0,
  documentsMarkedDeleted: 0,
  organizationsRenamed: 0,
  beneficiariesAnonymized: 0,
  counterpartiesAnonymized: 0,
  customerEmailsCleared: 0,
} as const;

/**
 * Applies the anonymisation rules of `anonymization.ts` to one user inside a single database
 * transaction. Ledger postings, TransactionEvent, TransferEvent and AuditLog rows are never
 * touched: the `ip` / `userAgent` captured on AuditLog follow the audit retention policy, not the
 * erasure request. The job is idempotent — a user whose `anonymizedAt` is set is skipped.
 *
 * Follow-up (documented, not implemented here): the encrypted blobs of the documents marked
 * `deletedAt` by this service are purged from STORAGE_DIR by a storage sweep once their
 * retention period has elapsed.
 */
@Injectable()
export class AnonymizationService {
  private readonly logger = new Logger(AnonymizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** argon2id hash of 32 random bytes: a valid hash that matches no password anyone knows. */
  randomPasswordHash(): Promise<string> {
    return argon2.hash(randomToken(32), {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async anonymizeUser(userId: string, triggeredBy: string): Promise<AnonymizationOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { memberships: { include: { organization: { select: { id: true, type: true } } } } },
    });
    if (!user) throw DomainError.notFound('User');
    if (user.anonymizedAt) {
      return { userId, anonymizedAt: user.anonymizedAt, alreadyAnonymized: true, ...EMPTY_OUTCOME };
    }
    const passwordHash = await this.randomPasswordHash();
    const now = new Date();
    const fields = buildAnonymizedUser(user, passwordHash, now);
    // The identifying email, captured before the row is rewritten (other organisations may hold
    // it as a counterparty or customer email).
    const email = { equals: user.email, mode: 'insensitive' as const };
    const personalOrganizationIds = user.memberships
      .filter((m) => m.organization.type === 'PERSONAL')
      .map((m) => m.organizationId);

    const outcome = await this.prisma.$transaction(async (db) => {
      await db.user.update({
        where: { id: userId },
        data: { ...fields, securityPreferences: Prisma.DbNull },
      });
      const sessions = await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      // Network identifiers of every session (revoked ones included) are personal data.
      await db.session.updateMany({ where: { userId }, data: { ip: null, userAgent: null } });
      // Authentication material: passkeys (their names often identify a device or a person) and
      // recovery codes are deleted, pending WebAuthn challenges too — nobody can sign in again.
      const passkeys = await db.webAuthnCredential.deleteMany({ where: { userId } });
      const recoveryCodes = await db.mfaRecoveryCode.deleteMany({ where: { userId } });
      await db.authChallenge.deleteMany({ where: { userId } });
      const verifications = await db.identityVerification.updateMany({
        where: { userId },
        data: {
          declaredData: ANONYMIZED_DECLARED_DATA as unknown as Prisma.InputJsonObject,
          providerResponse: Prisma.DbNull,
        },
      });
      // Documents the user uploaded for themselves: never evidence, never attached to a transaction
      // or a dispute conversation (those belong to the counterparties' records and are retained).
      const documents = await db.document.updateMany({
        where: {
          uploadedByUserId: userId,
          transactionId: null,
          deletedAt: null,
          evidences: { none: {} },
          disputeMessages: { none: {} },
        },
        data: { deletedAt: now },
      });
      const organizations = personalOrganizationIds.length
        ? await db.organization.updateMany({
            where: { id: { in: personalOrganizationIds } },
            data: { name: ANONYMIZED_ORGANIZATION_NAME },
          })
        : { count: 0 };
      // Beneficiaries of the PERSONAL organisation are the user's own contacts: the contact data is
      // erased, the identifier re-encrypted as a placeholder (the column is NOT NULL) and the row
      // soft-removed. Transfers keep their own masked snapshot, like any other history row.
      await db.beneficiary.updateMany({
        where: { organizationId: { in: personalOrganizationIds }, removedAt: null },
        data: { removedAt: now },
      });
      const beneficiaries = await db.beneficiary.updateMany({
        where: { organizationId: { in: personalOrganizationIds } },
        data: {
          name: ANONYMIZED_BENEFICIARY_NAME,
          phone: null,
          email: null,
          accountIdentifierEnc: sealString(this.env, KeyPurpose.BENEFICIARIES, ANONYMIZED_ACCOUNT_IDENTIFIER),
          accountIdentifierMasked: ANONYMIZED_ACCOUNT_IDENTIFIER_MASKED,
          status: 'REMOVED',
        },
      });
      // Other organisations' address books and documents that identify the user by email. The
      // `linkedOrganizationId` of a counterparty is kept: the organisation itself is renamed above.
      const counterparties = await db.counterparty.updateMany({
        where: { email },
        data: { name: ANONYMIZED_COUNTERPARTY_NAME, email: null, phone: null },
      });
      // Link requests still waiting for the user's personal workspace can no longer be decided:
      // they lapse (linkedOrganizationId stays null — it is only ever set while ACCEPTED).
      const linkRequests = personalOrganizationIds.length
        ? await db.counterparty.updateMany({
            where: { linkRequestedOrganizationId: { in: personalOrganizationIds }, linkStatus: 'PENDING' },
            data: { linkStatus: 'REVOKED', linkDecidedAt: now },
          })
        : { count: 0 };
      const invoices = await db.invoice.updateMany({
        where: { customerEmail: email },
        data: { customerEmail: null },
      });
      const quotes = await db.quote.updateMany({
        where: { customerEmail: email },
        data: { customerEmail: null },
      });
      await this.audit.log(
        {
          actorUserId: null,
          action: 'user.anonymized',
          entityType: 'User',
          entityId: userId,
          metadata: {
            triggeredBy,
            sessionsRevoked: sessions.count,
            verificationsAnonymized: verifications.count,
            documentsMarkedDeleted: documents.count,
            organizationsRenamed: organizations.count,
            beneficiariesAnonymized: beneficiaries.count,
            counterpartiesAnonymized: counterparties.count,
            customerEmailsCleared: invoices.count + quotes.count,
            passkeysDeleted: passkeys.count,
            recoveryCodesDeleted: recoveryCodes.count,
            linkRequestsRevoked: linkRequests.count,
            blobPurge: 'follow-up: storage sweep after retention',
            auditRetention: 'AuditLog ip/userAgent follow the audit retention policy',
          },
        },
        db,
      );
      return {
        userId,
        anonymizedAt: now,
        alreadyAnonymized: false,
        sessionsRevoked: sessions.count,
        verificationsAnonymized: verifications.count,
        documentsMarkedDeleted: documents.count,
        organizationsRenamed: organizations.count,
        beneficiariesAnonymized: beneficiaries.count,
        counterpartiesAnonymized: counterparties.count,
        customerEmailsCleared: invoices.count + quotes.count,
        passkeysDeleted: passkeys.count,
        recoveryCodesDeleted: recoveryCodes.count,
        linkRequestsRevoked: linkRequests.count,
      } satisfies AnonymizationOutcome;
    });
    this.logger.log(`user ${userId} anonymised (${triggeredBy})`);
    return outcome;
  }
}
