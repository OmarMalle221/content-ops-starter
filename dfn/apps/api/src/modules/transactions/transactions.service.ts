import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '@dfn/database';
import { renderProtectContract, type ProtectContractTerms } from '@dfn/contracts';
import {
  globalRoleHas,
  CANCELLABLE_TRANSACTION_STATES,
  ErrorCode,
  Permission,
  TransactionEventType,
  computeFeeMinor,
  isCorridorSupported,
  minorToDecimalString,
  parseDecimalToMinor,
  sumMinor,
  transactionMachine,
  type CreateTransactionInput,
  type ListTransactionsQuery,
} from '@dfn/shared';
import { isStaff, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { randomToken, sha256Hex } from '../../common/crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RiskService } from '../risk/risk.service';
import { PaymentsService } from '../payments/payments.service';
import {
  TransactionAccessService,
  transactionInclude,
  type TransactionWithRelations,
  type ViewerRole,
} from './transaction-access.service';
import { TransactionEventsService } from './transaction-events.service';
import {
  maskEmail,
  toTransactionDto,
  toTransactionSummary,
  type VerificationSnapshot,
} from './transaction.dto';

const INVITATION_TTL_DAYS = 14;
const DEFAULT_FEE_BPS = 150;

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly organizations: OrganizationsService,
    private readonly risk: RiskService,
    private readonly payments: PaymentsService,
    private readonly access: TransactionAccessService,
    private readonly events: TransactionEventsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────────────────────── Creation ─────────────────────────────

  async create(auth: AuthContext, input: CreateTransactionInput, req: Request) {
    const membership = this.organizations.resolveActingOrganization(
      auth,
      input.organizationId,
      Permission.TRANSACTION_CREATE,
    );
    const amountMinor = parseDecimalToMinor(input.amount, input.currencyCode);
    const milestoneAmounts = input.milestones.map((m) => parseDecimalToMinor(m.amount, input.currencyCode));
    if (sumMinor(milestoneAmounts) !== amountMinor) {
      throw DomainError.validation('The sum of milestone amounts must equal the transaction amount', {
        amount: input.amount,
        milestonesTotal: minorToDecimalString(sumMinor(milestoneAmounts), input.currencyCode),
      });
    }
    if (milestoneAmounts.some((m) => m <= 0n))
      throw DomainError.validation('Milestone amounts must be positive');
    if (input.seller.email.toLowerCase() === auth.email.toLowerCase()) {
      throw DomainError.validation('You cannot invite yourself as the seller');
    }
    const feeMinor = computeFeeMinor(amountMinor, DEFAULT_FEE_BPS);
    const buyerOrg = await this.prisma.organization.findUniqueOrThrow({
      where: { id: membership.organizationId },
    });
    const sellerUser = await this.prisma.user.findUnique({ where: { email: input.seller.email } });
    const inviteToken = randomToken(24);
    const meta = requestMeta(req);
    const corridorSupported = isCorridorSupported(input.originCountry, input.destinationCountry);

    const created = await this.prisma.$transaction(async (db) => {
      const reference = await this.generateReference(db);
      const terms: ProtectContractTerms = {
        transactionReference: reference,
        title: input.title,
        description: input.description,
        category: input.category,
        currencyCode: input.currencyCode,
        totalAmount: minorToDecimalString(amountMinor, input.currencyCode),
        platformFee: minorToDecimalString(feeMinor, input.currencyCode),
        originCountry: input.originCountry,
        destinationCountry: input.destinationCountry,
        deliveryDeadlineDays: input.terms.deliveryDeadlineDays,
        inspectionWindowDays: input.terms.inspectionWindowDays,
        governingLaw: input.terms.governingLaw,
        additionalClauses: input.terms.additionalClauses,
        parties: [
          { role: 'BUYER', displayName: buyerOrg.name, email: auth.email, country: buyerOrg.country },
          { role: 'SELLER', displayName: input.seller.name ?? input.seller.email, email: input.seller.email },
        ],
        milestones: input.milestones.map((m, i) => ({
          sequence: i + 1,
          title: m.title,
          description: m.description,
          amount: minorToDecimalString(milestoneAmounts[i], input.currencyCode),
          requiredEvidence: m.requiredEvidence,
        })),
      };
      const rendered = renderProtectContract(terms, (auth.locale as 'fr' | 'en') ?? 'fr');
      const tx = await db.transaction.create({
        data: {
          reference,
          createdByUserId: auth.userId,
          buyerOrganizationId: buyerOrg.id,
          title: input.title,
          description: input.description,
          category: input.category,
          currencyCode: input.currencyCode,
          amountMinor,
          feeMinor,
          feeBps: DEFAULT_FEE_BPS,
          status: input.sendInvitation ? 'PENDING_ACCEPTANCE' : 'DRAFT',
          originCountry: input.originCountry,
          destinationCountry: input.destinationCountry,
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
          metadata: { corridorSupported },
          parties: {
            create: [
              {
                role: 'BUYER',
                organizationId: buyerOrg.id,
                userId: auth.userId,
                invitedEmail: auth.email,
                invitedName: buyerOrg.name,
                status: 'ACCEPTED',
                acceptedAt: new Date(),
              },
              {
                role: 'SELLER',
                userId: sellerUser?.id ?? null,
                invitedEmail: input.seller.email,
                invitedName: input.seller.name ?? null,
                status: 'INVITED',
                inviteTokenHash: sha256Hex(inviteToken),
                inviteExpiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
              },
            ],
          },
          milestones: {
            create: input.milestones.map((m, i) => ({
              sequence: i + 1,
              title: m.title,
              description: m.description ?? null,
              amountMinor: milestoneAmounts[i],
              requiredEvidence: m.requiredEvidence,
            })),
          },
        },
      });
      const contract = await db.contract.create({
        data: { transactionId: tx.id, status: 'PENDING_ACCEPTANCE' },
      });
      const version = await db.contractVersion.create({
        data: {
          contractId: contract.id,
          version: 1,
          templateCode: rendered.templateCode,
          templateVersion: rendered.templateVersion,
          terms: terms as unknown as Prisma.InputJsonValue,
          bodyText: rendered.bodyText,
          contentHash: rendered.contentHash,
          createdByUserId: auth.userId,
        },
      });
      await db.contract.update({ where: { id: contract.id }, data: { currentVersionId: version.id } });
      await this.events.record(
        tx.id,
        TransactionEventType.CREATED,
        auth.userId,
        {
          reference,
          amount: terms.totalAmount,
          currency: input.currencyCode,
          milestones: input.milestones.length,
        },
        db,
      );
      await this.events.record(
        tx.id,
        TransactionEventType.CONTRACT_GENERATED,
        auth.userId,
        { contractVersionId: version.id, contentHash: rendered.contentHash },
        db,
      );
      if (input.sendInvitation) {
        await this.events.record(
          tx.id,
          TransactionEventType.PARTY_INVITED,
          auth.userId,
          { role: 'SELLER', email: maskEmail(input.seller.email) },
          db,
        );
      }
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: buyerOrg.id,
          action: 'transaction.created',
          entityType: 'Transaction',
          entityId: tx.id,
          metadata: { reference, amount: terms.totalAmount, currency: input.currencyCode },
          ...meta,
        },
        db,
      );
      return tx;
    });

    if (sellerUser) {
      await this.notifications.notify({
        userId: sellerUser.id,
        type: 'transaction.invited',
        title: `Invitation — ${created.reference}`,
        body: `${buyerOrg.name} vous invite à une transaction sécurisée (sandbox) : « ${input.title} ».`,
        data: { transactionId: created.id, invitationToken: inviteToken },
      });
    }
    const facts = await this.risk.transactionFacts({
      userId: auth.userId,
      organizationId: buyerOrg.id,
      amountMinor,
      currencyCode: input.currencyCode,
      originCountry: input.originCountry,
      destinationCountry: input.destinationCountry,
      corridorSupported,
    });
    await this.risk.evaluateAndRecord({ ...facts, event: 'transaction.created', transactionId: created.id });

    const dto = await this.get(auth, created.id);
    return {
      ...dto,
      // Returned once to the creator so the invitation link can be shared (email transport is log-only in sandbox).
      invitation: {
        token: inviteToken,
        acceptUrl: `${this.env.WEB_PUBLIC_URL}/invite/${inviteToken}`,
        expiresAt: created.expiresAt,
      },
    };
  }

  private async generateReference(db: Prisma.TransactionClient): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = `DFN-${new Date().getUTCFullYear()}-${randomToken(4)
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase()
        .padEnd(6, '7')
        .slice(0, 6)}`;
      const exists = await db.transaction.findUnique({
        where: { reference: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw DomainError.conflict('Could not allocate a transaction reference');
  }

  // ───────────────────────────── Reads ─────────────────────────────

  async list(auth: AuthContext, query: ListTransactionsQuery) {
    const orgIds = auth.memberships.map((m) => m.organizationId);
    const asBuyer: Prisma.TransactionWhereInput = { buyerOrganizationId: { in: orgIds } };
    // Seller-side transactions the user joined personally (invitation accepted before an
    // organisation was attached) are resolved up front: a `parties: { some }` filter becomes a
    // correlated EXISTS over every candidate row, far too slow on large tables (docs/operations/PERFORMANCE.md).
    const sellerPartyTxIds = (
      await this.prisma.transactionParty.findMany({
        where: { role: 'SELLER', userId: auth.userId },
        select: { transactionId: true },
      })
    ).map((p) => p.transactionId);
    const asSeller: Prisma.TransactionWhereInput = {
      OR: [
        { sellerOrganizationId: { in: orgIds } },
        ...(sellerPartyTxIds.length ? [{ id: { in: sellerPartyTxIds } }] : []),
      ],
    };
    const scope: Prisma.TransactionWhereInput =
      isStaff(auth) && !query.organizationId
        ? {}
        : query.role === 'BUYER'
          ? asBuyer
          : query.role === 'SELLER'
            ? asSeller
            : { OR: [asBuyer, asSeller] };
    const where: Prisma.TransactionWhereInput = {
      AND: [
        scope,
        query.organizationId
          ? {
              OR: [
                { buyerOrganizationId: query.organizationId },
                { sellerOrganizationId: query.organizationId },
              ],
            }
          : {},
        query.status ? { status: { in: query.status.split(',') as any } } : {},
        query.search
          ? {
              OR: [
                { title: { contains: query.search, mode: 'insensitive' } },
                { reference: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: transactionInclude,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return {
      items: items.map((tx) => toTransactionSummary(tx, this.access.roleFor(auth, tx) ?? 'STAFF')),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(auth: AuthContext, id: string) {
    const { tx, role } = await this.access.loadFor(auth, id);
    return this.toDto(tx, role, auth);
  }

  async toDto(tx: TransactionWithRelations, role: ViewerRole, auth: AuthContext) {
    const [escrowBalanceMinor, verification] = await Promise.all([
      this.payments.escrowBalance(tx),
      this.verificationSnapshot(tx),
    ]);
    return toTransactionDto(tx, role, {
      escrowBalanceMinor,
      verification,
      userId: auth.userId,
      canSimulatePartner: globalRoleHas(auth.globalRole, Permission.SANDBOX_PARTNER_SIMULATE),
      partyOrgRole: this.access.partyOrgRole(auth, tx, role),
    });
  }

  async events_(auth: AuthContext, id: string) {
    await this.access.loadFor(auth, id);
    return this.events.list(id);
  }

  async verificationSnapshot(tx: TransactionWithRelations): Promise<VerificationSnapshot> {
    const buyer = tx.parties.find((p) => p.role === 'BUYER');
    const seller = tx.parties.find((p) => p.role === 'SELLER');
    const statusFor = async (userId?: string | null) => {
      if (!userId) return 'NOT_STARTED';
      const v = await this.prisma.identityVerification.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      return v?.status ?? 'NOT_STARTED';
    };
    const [buyerIdentity, sellerIdentity] = await Promise.all([
      statusFor(buyer?.userId),
      statusFor(seller?.userId),
    ]);
    const required = this.env.REQUIRE_VERIFICATION_BEFORE_FUNDING;
    const reasons: string[] = [];
    if (required && buyerIdentity !== 'SIMULATED_PASS') reasons.push('BUYER_IDENTITY_NOT_VERIFIED');
    if (required && sellerIdentity !== 'SIMULATED_PASS') reasons.push('SELLER_IDENTITY_NOT_VERIFIED');
    if (seller?.status !== 'ACCEPTED') reasons.push('SELLER_NOT_ACCEPTED');
    if (tx.contract?.status !== 'ACCEPTED') reasons.push('CONTRACT_NOT_ACCEPTED');
    return { buyerIdentity, sellerIdentity, required, fundingAllowed: reasons.length === 0, reasons };
  }

  // ───────────────────────────── Invitations ─────────────────────────────

  async getInvitation(token: string) {
    const party = await this.prisma.transactionParty.findUnique({
      where: { inviteTokenHash: sha256Hex(token) },
      include: {
        transaction: {
          include: {
            buyerOrganization: { select: { name: true, country: true } },
            milestones: { orderBy: { sequence: 'asc' } },
          },
        },
      },
    });
    if (!party)
      throw new DomainError(ErrorCode.INVITATION_INVALID, 'Invitation not found', HttpStatus.NOT_FOUND);
    const expired = party.inviteExpiresAt ? party.inviteExpiresAt < new Date() : false;
    const existingUser = await this.prisma.user.findUnique({
      where: { email: party.invitedEmail },
      select: { id: true },
    });
    const tx = party.transaction;
    return {
      transactionId: tx.id,
      reference: tx.reference,
      title: tx.title,
      description: tx.description,
      category: tx.category,
      amount: {
        minor: tx.amountMinor.toString(),
        decimal: minorToDecimalString(tx.amountMinor, tx.currencyCode),
        currency: tx.currencyCode,
      },
      originCountry: tx.originCountry,
      destinationCountry: tx.destinationCountry,
      buyer: tx.buyerOrganization,
      invitedEmail: maskEmail(party.invitedEmail),
      partyStatus: party.status,
      transactionStatus: tx.status,
      expired,
      expiresAt: party.inviteExpiresAt,
      requiresRegistration: !existingUser,
      milestones: tx.milestones.map((m) => ({
        sequence: m.sequence,
        title: m.title,
        amount: minorToDecimalString(m.amountMinor, tx.currencyCode),
      })),
      sandbox: true,
    };
  }

  async acceptInvitation(token: string, auth: AuthContext, req: Request, organizationId?: string) {
    const party = await this.prisma.transactionParty.findUnique({
      where: { inviteTokenHash: sha256Hex(token) },
      include: { transaction: true },
    });
    if (
      !party ||
      party.status !== 'INVITED' ||
      (party.inviteExpiresAt && party.inviteExpiresAt < new Date())
    ) {
      throw new DomainError(
        ErrorCode.INVITATION_INVALID,
        'Invitation is invalid, already used or expired',
        HttpStatus.GONE,
      );
    }
    if (party.invitedEmail.toLowerCase() !== auth.email.toLowerCase()) {
      throw DomainError.forbidden('This invitation was addressed to another email');
    }
    const membership = this.organizations.resolveActingOrganization(
      auth,
      organizationId,
      Permission.TRANSACTION_MANAGE,
    );
    if (membership.organizationId === party.transaction.buyerOrganizationId) {
      throw DomainError.validation('Buyer and seller cannot be the same organisation');
    }
    transactionMachine.assertTransition(party.transaction.status, 'ACCEPTED');
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.transactionParty.update({
        where: { id: party.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          userId: auth.userId,
          organizationId: membership.organizationId,
        },
      });
      await db.transaction.update({
        where: { id: party.transactionId },
        data: { sellerOrganizationId: membership.organizationId, status: 'ACCEPTED', acceptedAt: new Date() },
      });
      await this.events.record(
        party.transactionId,
        TransactionEventType.PARTY_ACCEPTED,
        auth.userId,
        { role: 'SELLER', organizationId: membership.organizationId },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: membership.organizationId,
          action: 'transaction.invitation_accepted',
          entityType: 'Transaction',
          entityId: party.transactionId,
          ...meta,
        },
        db,
      );
    });
    const tx = await this.access.load(party.transactionId);
    const buyers = await this.access.partyUserIds(tx, 'BUYER');
    await this.notifications.notifyMany(buyers, {
      type: 'transaction.party_accepted',
      title: `Vendeur confirmé — ${tx.reference}`,
      body: `Le vendeur a rejoint la transaction « ${tx.title} ». Les deux parties doivent maintenant accepter les conditions.`,
      data: { transactionId: tx.id },
    });
    return this.toDto(tx, 'SELLER', auth);
  }

  async declineInvitation(token: string, auth: AuthContext, req: Request) {
    const party = await this.prisma.transactionParty.findUnique({
      where: { inviteTokenHash: sha256Hex(token) },
      include: { transaction: true },
    });
    if (!party || party.status !== 'INVITED')
      throw new DomainError(ErrorCode.INVITATION_INVALID, 'Invitation is invalid', HttpStatus.GONE);
    if (party.invitedEmail.toLowerCase() !== auth.email.toLowerCase()) throw DomainError.forbidden();
    transactionMachine.assertTransition(party.transaction.status, 'CANCELLED');
    await this.prisma.$transaction(async (db) => {
      await db.transactionParty.update({
        where: { id: party.id },
        data: { status: 'DECLINED', userId: auth.userId },
      });
      await db.transaction.update({
        where: { id: party.transactionId },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await this.events.record(
        party.transactionId,
        TransactionEventType.PARTY_DECLINED,
        auth.userId,
        { role: 'SELLER' },
        db,
      );
      await this.events.record(
        party.transactionId,
        TransactionEventType.CANCELLED,
        auth.userId,
        { reason: 'Seller declined the invitation' },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'transaction.invitation_declined',
          entityType: 'Transaction',
          entityId: party.transactionId,
          ...requestMeta(req),
        },
        db,
      );
    });
    const tx = await this.access.load(party.transactionId);
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, 'BUYER'), {
      type: 'transaction.party_declined',
      title: `Invitation refusée — ${tx.reference}`,
      body: `Le vendeur a refusé l'invitation. La transaction a été annulée.`,
      data: { transactionId: tx.id },
    });
    return { declined: true };
  }

  async resendInvitation(auth: AuthContext, id: string, req: Request) {
    const { tx, role } = await this.access.loadFor(auth, id);
    this.access.assertPartyCan(auth, tx, role, 'BUYER');
    const seller = tx.parties.find((p) => p.role === 'SELLER');
    if (!seller || seller.status !== 'INVITED')
      throw DomainError.invalidTransition('The seller has already responded');
    const token = randomToken(24);
    await this.prisma.$transaction(async (db) => {
      await db.transactionParty.update({
        where: { id: seller.id },
        data: {
          inviteTokenHash: sha256Hex(token),
          inviteExpiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
          invitedAt: new Date(),
        },
      });
      await db.transaction.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000) },
      });
      await this.events.record(
        id,
        TransactionEventType.PARTY_INVITED,
        auth.userId,
        { role: 'SELLER', resent: true },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: tx.buyerOrganizationId,
          action: 'transaction.invitation_resent',
          entityType: 'Transaction',
          entityId: id,
          ...requestMeta(req),
        },
        db,
      );
    });
    if (seller.userId) {
      await this.notifications.notify({
        userId: seller.userId,
        type: 'transaction.invited',
        title: `Rappel d'invitation — ${tx.reference}`,
        body: `Vous êtes invité·e à la transaction « ${tx.title} ».`,
        data: { transactionId: tx.id, invitationToken: token },
      });
    }
    return { token, acceptUrl: `${this.env.WEB_PUBLIC_URL}/invite/${token}` };
  }

  // ───────────────────────────── Contract ─────────────────────────────

  async acceptTerms(auth: AuthContext, id: string, contractVersionId: string, req: Request) {
    const { tx, role } = await this.access.loadFor(auth, id);
    this.access.assertPartyCan(auth, tx, role, 'BUYER', 'SELLER');
    const version = tx.contract?.currentVersion;
    if (!version || version.id !== contractVersionId)
      throw DomainError.conflict('Contract version is not current');
    if (!['PENDING_ACCEPTANCE', 'ACCEPTED'].includes(tx.status))
      throw DomainError.invalidTransition(`Cannot accept terms while transaction is ${tx.status}`);
    const party = tx.parties.find((p) => p.role === role);
    if (!party || party.status !== 'ACCEPTED')
      throw DomainError.invalidTransition('Join the transaction before accepting the terms');
    if (version.acceptances.some((a) => a.partyId === party.id))
      throw DomainError.conflict('Terms already accepted');
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.contractAcceptance.create({
        data: {
          contractVersionId: version.id,
          partyId: party.id,
          userId: auth.userId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      });
      const count = await db.contractAcceptance.count({ where: { contractVersionId: version.id } });
      await this.events.record(
        id,
        TransactionEventType.CONTRACT_ACCEPTED,
        auth.userId,
        { role, contractVersionId: version.id, contentHash: version.contentHash },
        db,
      );
      if (count >= 2) {
        await db.contract.update({ where: { id: tx.contract!.id }, data: { status: 'ACCEPTED' } });
        await this.events.record(
          id,
          TransactionEventType.VERIFICATION_REQUIRED,
          auth.userId,
          { note: 'Both parties accepted the contract. Identity verification is required before funding.' },
          db,
        );
      }
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'contract.accepted',
          entityType: 'ContractVersion',
          entityId: version.id,
          metadata: { transactionId: id, role },
          ...meta,
        },
        db,
      );
    });
    const other = role === 'BUYER' ? 'SELLER' : 'BUYER';
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, other), {
      type: 'contract.accepted',
      title: `Conditions acceptées — ${tx.reference}`,
      body: `${role === 'BUYER' ? "L'acheteur" : 'Le vendeur'} a accepté les conditions contractuelles.`,
      data: { transactionId: id },
    });
    return this.get(auth, id);
  }

  // ───────────────────────────── Funding ─────────────────────────────

  async requestFunding(
    auth: AuthContext,
    id: string,
    input: { method: 'BANK_TRANSFER_SIMULATED' | 'WALLET_SIMULATED' },
    req: Request,
  ) {
    const { tx, role } = await this.access.loadFor(auth, id);
    this.access.assertPartyCan(auth, tx, role, 'BUYER');
    const verification = await this.verificationSnapshot(tx);
    if (!verification.fundingAllowed) {
      throw new DomainError(
        ErrorCode.VERIFICATION_REQUIRED,
        'Funding is not allowed yet',
        HttpStatus.CONFLICT,
        verification,
      );
    }
    await this.payments.createFundingRequest(auth, tx, input, req);
    return this.get(auth, id);
  }

  // ───────────────────────────── Cancellation ─────────────────────────────

  async cancel(auth: AuthContext, id: string, reason: string, req: Request) {
    const { tx, role } = await this.access.loadFor(auth, id);
    // Only the parties cancel (with TRANSACTION_MANAGE): staff are read-only on Protect transactions
    // (no support write).
    this.access.assertPartyCan(auth, tx, role, 'BUYER', 'SELLER');
    if (!CANCELLABLE_TRANSACTION_STATES.includes(tx.status)) {
      throw DomainError.invalidTransition(
        `A ${tx.status} transaction cannot be cancelled; open a dispute instead`,
      );
    }
    transactionMachine.assertTransition(tx.status, 'CANCELLED');
    await this.prisma.$transaction(async (db) => {
      await db.transaction.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await db.fundingRequest.updateMany({
        where: { transactionId: id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      await db.milestone.updateMany({ where: { transactionId: id }, data: { status: 'CANCELLED' } });
      await this.events.record(id, TransactionEventType.CANCELLED, auth.userId, { reason, by: role }, db);
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'transaction.cancelled',
          entityType: 'Transaction',
          entityId: id,
          metadata: { reason },
          ...requestMeta(req),
        },
        db,
      );
    });
    const other = role === 'BUYER' ? 'SELLER' : 'BUYER';
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, other), {
      type: 'transaction.cancelled',
      title: `Transaction annulée — ${tx.reference}`,
      body: `La transaction « ${tx.title} » a été annulée : ${reason}`,
      data: { transactionId: id },
    });
    return this.get(auth, id);
  }

  /** Expire stale invitations / unfunded transactions (called by the maintenance job). */
  async expireStale() {
    const now = new Date();
    const stale = await this.prisma.transaction.findMany({
      where: { status: { in: ['PENDING_ACCEPTANCE', 'AWAITING_FUNDING'] }, expiresAt: { lt: now } },
      select: { id: true, status: true },
    });
    for (const tx of stale) {
      await this.prisma.$transaction(async (db) => {
        await db.transaction.update({ where: { id: tx.id }, data: { status: 'EXPIRED' } });
        await db.transactionParty.updateMany({
          where: { transactionId: tx.id, status: 'INVITED' },
          data: { status: 'EXPIRED' },
        });
        await db.fundingRequest.updateMany({
          where: { transactionId: tx.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
        await this.events.record(tx.id, TransactionEventType.EXPIRED, null, { from: tx.status }, db);
      });
    }
    await this.prisma.fundingRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });
    return { expired: stale.length };
  }
}
