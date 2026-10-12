import { HttpStatus, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import type { Counterparty, PrismaTransactionClient } from '@dfn/database';
import {
  COUNTERPARTY_LINK_COOLDOWN_HOURS,
  COUNTERPARTY_LINK_REQUESTS_PER_DAY,
  CounterpartyLinkPublicStatus,
  CounterpartyLinkRequestOutcome,
  CounterpartyLinkStatus,
  ErrorCode,
  Permission,
  orgRoleHas,
  type CreateCounterpartyInput,
  type DecideCounterpartyLinkInput,
  type ListLinkRequestsQuery,
  type RequestCounterpartyLinkInput,
  type RevokeCounterpartyLinkInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService, type TenantAccess } from './organizations.service';

const HOUR_MS = 3_600_000;
const SANDBOX_NOTE = 'Données fictives — Aucun fonds réel.';

/** Requester-side view: NONE + PENDING look the same once a request was attempted (no enumeration). */
export function publicLinkStatus(
  cp: Pick<Counterparty, 'linkStatus' | 'linkRequestedAt'>,
): CounterpartyLinkPublicStatus {
  switch (cp.linkStatus) {
    case CounterpartyLinkStatus.ACCEPTED:
      return CounterpartyLinkPublicStatus.ACCEPTED;
    case CounterpartyLinkStatus.DECLINED:
      return CounterpartyLinkPublicStatus.DECLINED;
    case CounterpartyLinkStatus.REVOKED:
      return CounterpartyLinkPublicStatus.REVOKED;
    case CounterpartyLinkStatus.PENDING:
      return CounterpartyLinkPublicStatus.REQUESTED;
    default:
      return cp.linkRequestedAt ? CounterpartyLinkPublicStatus.REQUESTED : CounterpartyLinkPublicStatus.NONE;
  }
}

/** Earliest date a declined / revoked link may be requested again (null when not in cooldown). */
function cooldownUntil(cp: Pick<Counterparty, 'linkStatus' | 'linkDecidedAt'>): Date | null {
  if (cp.linkStatus !== CounterpartyLinkStatus.DECLINED && cp.linkStatus !== CounterpartyLinkStatus.REVOKED)
    return null;
  if (!cp.linkDecidedAt) return null;
  return new Date(cp.linkDecidedAt.getTime() + COUNTERPARTY_LINK_COOLDOWN_HOURS * HOUR_MS);
}

/**
 * Counterparty DTO for the REQUESTING organisation. Never exposes `linkRequestedOrganizationId` nor
 * the raw link status: until the target decides, a request towards an existing account and a request
 * towards an unknown e-mail produce exactly the same representation.
 */
export function toCounterpartyDto(
  cp: Counterparty,
  options: { canManage: boolean; linkedOrganizationName?: string | null; now?: Date },
) {
  const now = options.now ?? new Date();
  const status = publicLinkStatus(cp);
  const accepted = status === CounterpartyLinkPublicStatus.ACCEPTED;
  const decided =
    accepted ||
    status === CounterpartyLinkPublicStatus.DECLINED ||
    status === CounterpartyLinkPublicStatus.REVOKED;
  const until = cooldownUntil(cp);
  const nextActions: string[] = [];
  if (options.canManage) {
    if (status === CounterpartyLinkPublicStatus.REQUESTED || accepted) nextActions.push('REVOKE_LINK');
    if (
      cp.email &&
      (status === CounterpartyLinkPublicStatus.NONE ||
        ((status === CounterpartyLinkPublicStatus.DECLINED ||
          status === CounterpartyLinkPublicStatus.REVOKED) &&
          (!until || until <= now)))
    ) {
      nextActions.push('REQUEST_LINK');
    }
  }
  return {
    id: cp.id,
    organizationId: cp.organizationId,
    name: cp.name,
    email: cp.email,
    phone: cp.phone,
    country: cp.country,
    notes: cp.notes,
    /** Only set once the target organisation accepted the link. */
    linkedOrganizationId: accepted ? cp.linkedOrganizationId : null,
    link: {
      status,
      requestedAt: cp.linkRequestedAt,
      decidedAt: decided ? cp.linkDecidedAt : null,
      linkedOrganization:
        accepted && cp.linkedOrganizationId
          ? { id: cp.linkedOrganizationId, name: options.linkedOrganizationName ?? null }
          : null,
      requestAgainAfter: until && until > now ? until : null,
      nextActions,
    },
    createdAt: cp.createdAt,
    updatedAt: cp.updatedAt,
  };
}
export type CounterpartyDto = ReturnType<typeof toCounterpartyDto>;

type LinkRequestRow = Counterparty & {
  organization: { id: string; name: string; type: string; country: string };
};

/** Link request as seen by the TARGET organisation (the one asked to accept). */
function toLinkRequestDto(row: LinkRequestRow, canDecide: boolean) {
  return {
    counterpartyId: row.id,
    status: row.linkStatus,
    requesterOrganization: {
      id: row.organization.id,
      name: row.organization.name,
      type: row.organization.type,
      country: row.organization.country,
    },
    /** Name (and e-mail) as typed by the requesting organisation. */
    counterpartyName: row.name,
    counterpartyEmail: row.email,
    requestedAt: row.linkRequestedAt,
    decidedAt: row.linkDecidedAt,
    nextActions: !canDecide
      ? []
      : row.linkStatus === CounterpartyLinkStatus.PENDING
        ? ['ACCEPT', 'DECLINE']
        : row.linkStatus === CounterpartyLinkStatus.ACCEPTED
          ? ['REVOKE']
          : [],
    sandbox: true as const,
  };
}

/**
 * Client records (counterparties) and the link-consent workflow (Phase 6).
 *
 * Requester side (organisation A): creating a counterparty with an e-mail — or with an explicit
 * organisation the caller belongs to — sends a link request (PENDING) to the personal workspace of the
 * matching active DFN user (or to the explicit organisation). Nothing is linked until the target
 * accepts. The response is identical whether or not an account matched. A can revoke a request or a
 * link, and re-request after a decline / revocation once the cooldown has elapsed.
 *
 * Target side (organisation B): OWNER / ADMIN (ORG_LINK_DECIDE) list pending requests, accept or
 * decline them, and can end an accepted link at any time. Support staff can read but never decide
 * on behalf of a tenant.
 */
@Injectable()
export class CounterpartiesService implements OnModuleDestroy {
  private readonly logger = new Logger(CounterpartiesService.name);
  /** Target notifications sent after the response (see `notifyAfterResponse`). */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrganizationsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleDestroy() {
    await this.whenIdle();
  }

  /** Resolves once every pending target notification has settled (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * The target of a link request is notified AFTER the response, never inside it: a matching
   * account would otherwise cost measurably more (organisation lookup, decision makers, one
   * notification per recipient) and a notification failure would surface as a 500 on matches only.
   */
  private notifyAfterResponse(target: string, requesterOrganizationId: string, counterpartyId: string) {
    const pending: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.notifyTargetOfRequest(target, requesterOrganizationId, counterpartyId))
      .catch((err: unknown) => {
        this.logger.warn(
          `link request notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => this.inFlight.delete(pending));
    this.inFlight.add(pending);
  }

  // ───────────────────────────── Requester side ─────────────────────────────

  private canManage(access: TenantAccess): boolean {
    return access.via === 'MEMBERSHIP' && orgRoleHas(access.role, Permission.TRANSACTION_CREATE);
  }

  private async linkedNames(rows: Counterparty[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.linkStatus === CounterpartyLinkStatus.ACCEPTED && r.linkedOrganizationId)
          .map((r) => r.linkedOrganizationId!),
      ),
    ];
    if (ids.length === 0) return new Map();
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(orgs.map((o) => [o.id, o.name]));
  }

  private async dto(cp: Counterparty, access: TenantAccess) {
    const names = await this.linkedNames([cp]);
    return toCounterpartyDto(cp, {
      canManage: this.canManage(access),
      linkedOrganizationName: cp.linkedOrganizationId ? names.get(cp.linkedOrganizationId) : null,
    });
  }

  async list(auth: AuthContext, organizationId: string): Promise<CounterpartyDto[]> {
    const access = this.orgs.assertMember(auth, organizationId); // read: members and staff
    const rows = await this.prisma.counterparty.findMany({
      where: { organizationId },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
    const names = await this.linkedNames(rows);
    const now = new Date();
    return rows.map((cp) =>
      toCounterpartyDto(cp, {
        canManage: this.canManage(access),
        linkedOrganizationName: cp.linkedOrganizationId ? names.get(cp.linkedOrganizationId) : null,
        now,
      }),
    );
  }

  private async loadOwn(organizationId: string, counterpartyId: string) {
    const cp = await this.prisma.counterparty.findFirst({ where: { id: counterpartyId, organizationId } });
    if (!cp) throw DomainError.notFound('Counterparty');
    return cp;
  }

  /**
   * An explicit link target must be an organisation the caller belongs to: accepting an arbitrary
   * identifier would let anyone probe organisation ids. Same error whether it does not exist or the
   * caller is not a member.
   */
  private async explicitTarget(auth: AuthContext, organizationId: string, target: string): Promise<string> {
    const membership = await this.prisma.organizationMember.findFirst({
      where: { organizationId: target, userId: auth.userId, organization: { deletedAt: null } },
      select: { organizationId: true },
    });
    if (!membership) throw DomainError.validation('Linked organisation not found');
    if (membership.organizationId === organizationId)
      throw DomainError.validation('A counterparty cannot link to its own organisation');
    return membership.organizationId;
  }

  /** Personal workspace of an ACTIVE DFN user with that e-mail, or null (never revealed to the caller). */
  private async eligibleTargetForEmail(email: string, organizationId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') return null;
    const personal = await this.prisma.organizationMember.findFirst({
      where: { userId: user.id, role: 'OWNER', organization: { type: 'PERSONAL', deletedAt: null } },
      select: { organizationId: true },
    });
    if (!personal || personal.organizationId === organizationId) return null;
    return personal.organizationId;
  }

  /**
   * True when the target declined or ended a link with this requester organisation less than the
   * cooldown ago, on ANY of its client records: a new record must not reopen a decision. Callers
   * then send nothing, silently — the response stays identical, so it reveals no account.
   */
  private async targetCoolingDown(organizationId: string, target: string, now: Date): Promise<boolean> {
    const recent = await this.prisma.counterparty.findFirst({
      where: {
        organizationId,
        linkRequestedOrganizationId: target,
        linkStatus: { in: [CounterpartyLinkStatus.DECLINED, CounterpartyLinkStatus.REVOKED] },
        linkDecidedAt: { gt: new Date(now.getTime() - COUNTERPARTY_LINK_COOLDOWN_HOURS * HOUR_MS) },
      },
      select: { id: true },
    });
    return recent !== null;
  }

  /**
   * Per-organisation quota of link requests over a rolling 24 h window. Every ATTEMPT counts (with or
   * without a matching account), so the limit itself cannot be used to enumerate accounts. Serialised
   * per organisation with a transaction-scoped advisory lock.
   */
  private async assertRequestQuota(db: PrismaTransactionClient, organizationId: string, now: Date) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`counterparty-link:${organizationId}`}))`;
    const since = new Date(now.getTime() - 24 * HOUR_MS);
    const recent = await db.counterparty.findMany({
      where: { organizationId, linkRequestedAt: { gte: since } },
      select: { linkRequestedAt: true },
      orderBy: { linkRequestedAt: 'asc' },
    });
    if (recent.length >= COUNTERPARTY_LINK_REQUESTS_PER_DAY) {
      const oldest = recent[0]!.linkRequestedAt!;
      throw new DomainError(
        ErrorCode.RATE_LIMITED,
        `Too many link requests for this organisation (max ${COUNTERPARTY_LINK_REQUESTS_PER_DAY} per 24 h)`,
        HttpStatus.TOO_MANY_REQUESTS,
        {
          limit: COUNTERPARTY_LINK_REQUESTS_PER_DAY,
          windowHours: 24,
          retryAt: new Date(oldest.getTime() + 24 * HOUR_MS).toISOString(),
        },
      );
    }
  }

  private async decisionMakers(organizationId: string): Promise<string[]> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: { in: ['OWNER', 'ADMIN'] }, user: { status: 'ACTIVE' } },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  private async notifyTargetOfRequest(
    target: string,
    requesterOrganizationId: string,
    counterpartyId: string,
  ) {
    const requester = await this.prisma.organization.findUnique({
      where: { id: requesterOrganizationId },
      select: { name: true },
    });
    const name = requester?.name ?? 'Une organisation';
    await this.notifications.notifyMany(await this.decisionMakers(target), {
      type: 'counterparty.link_requested',
      title: `${name} souhaite vous relier comme client`,
      body: `${name} souhaite vous relier comme client sur Diaspora Trust (sandbox) — accepter/refuser depuis Entreprise › Liaisons. Tant que vous n’avez pas accepté, ses factures et devis ne vous sont ni visibles ni payables. ${SANDBOX_NOTE}`,
      data: {
        organizationId: target,
        counterpartyId,
        url: `/business/links?organizationId=${target}`,
      },
    });
  }

  async create(auth: AuthContext, organizationId: string, input: CreateCounterpartyInput, req: Request) {
    const access = await this.orgs.authorizeWrite(auth, organizationId, Permission.TRANSACTION_CREATE, req);
    const wantsLink = Boolean(input.email || input.linkedOrganizationId);
    let target: string | null = null;
    if (input.linkedOrganizationId) {
      target = await this.explicitTarget(auth, organizationId, input.linkedOrganizationId);
    } else if (input.email) {
      target = await this.eligibleTargetForEmail(input.email, organizationId);
    }
    const now = new Date();
    if (target && (await this.targetCoolingDown(organizationId, target, now))) target = null;
    const meta = requestMeta(req);
    const outcome = wantsLink
      ? CounterpartyLinkRequestOutcome.SENT_IF_ELIGIBLE
      : CounterpartyLinkRequestOutcome.NOT_REQUESTED;
    const cp = await this.prisma.$transaction(async (db) => {
      if (wantsLink) await this.assertRequestQuota(db, organizationId, now);
      const created = await db.counterparty.create({
        data: {
          organizationId,
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          country: input.country ?? null,
          notes: input.notes ?? null,
          linkedOrganizationId: null,
          linkStatus: target ? CounterpartyLinkStatus.PENDING : CounterpartyLinkStatus.NONE,
          linkRequestedOrganizationId: target,
          linkRequestedAt: wantsLink ? now : null,
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: 'counterparty.created',
          entityType: 'Counterparty',
          entityId: created.id,
          metadata: { linkRequest: outcome, support: access.via === 'STAFF_SUPPORT' },
          ...meta,
        },
        db,
      );
      if (target) {
        // Recorded on the TARGET organisation (staff-only audit trail): the requester never sees it.
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: target,
            action: 'counterparty.link_requested',
            entityType: 'Counterparty',
            entityId: created.id,
            metadata: {
              requesterOrganizationId: organizationId,
              via: input.linkedOrganizationId ? 'EXPLICIT_ORGANIZATION' : 'EMAIL',
            },
            ...meta,
          },
          db,
        );
      }
      return created;
    });
    if (target) this.notifyAfterResponse(target, organizationId, cp.id);
    return { ...(await this.dto(cp, access)), linkRequest: outcome };
  }

  /** Sends a new link request after a decline / revocation (cooldown) or for an unlinked client. */
  async requestLink(
    auth: AuthContext,
    organizationId: string,
    counterpartyId: string,
    input: RequestCounterpartyLinkInput,
    req: Request,
  ) {
    const access = await this.orgs.authorizeWrite(auth, organizationId, Permission.TRANSACTION_CREATE, req);
    const cp = await this.loadOwn(organizationId, counterpartyId);
    const status = publicLinkStatus(cp);
    if (
      status === CounterpartyLinkPublicStatus.REQUESTED ||
      status === CounterpartyLinkPublicStatus.ACCEPTED
    ) {
      throw DomainError.conflict('A link request is already in progress or the client is already linked', {
        status,
      });
    }
    const now = new Date();
    const until = cooldownUntil(cp);
    if (until && until > now) {
      throw new DomainError(
        ErrorCode.RATE_LIMITED,
        `A new link request is possible ${COUNTERPARTY_LINK_COOLDOWN_HOURS} h after a decline or a revocation`,
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAt: until.toISOString(), cooldownHours: COUNTERPARTY_LINK_COOLDOWN_HOURS },
      );
    }
    if (!cp.email && !input.linkedOrganizationId) {
      throw DomainError.validation('An e-mail address or an organisation is required to request a link');
    }
    let target = input.linkedOrganizationId
      ? await this.explicitTarget(auth, organizationId, input.linkedOrganizationId)
      : await this.eligibleTargetForEmail(cp.email!, organizationId);
    if (target && (await this.targetCoolingDown(organizationId, target, now))) target = null;
    const meta = requestMeta(req);
    const updated = await this.prisma.$transaction(async (db) => {
      await this.assertRequestQuota(db, organizationId, now);
      const res = await db.counterparty.updateMany({
        where: { id: cp.id, organizationId, linkStatus: cp.linkStatus, updatedAt: cp.updatedAt },
        data: {
          linkedOrganizationId: null,
          linkStatus: target ? CounterpartyLinkStatus.PENDING : CounterpartyLinkStatus.NONE,
          linkRequestedOrganizationId: target,
          linkRequestedAt: now,
          linkDecidedAt: null,
          linkDecidedByUserId: null,
        },
      });
      if (res.count === 0) throw DomainError.conflict('The client record changed meanwhile, please retry');
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: 'counterparty.link_rerequested',
          entityType: 'Counterparty',
          entityId: cp.id,
          metadata: {
            from: status,
            linkRequest: CounterpartyLinkRequestOutcome.SENT_IF_ELIGIBLE,
            support: access.via === 'STAFF_SUPPORT',
          },
          ...meta,
        },
        db,
      );
      if (target) {
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: target,
            action: 'counterparty.link_requested',
            entityType: 'Counterparty',
            entityId: cp.id,
            metadata: {
              requesterOrganizationId: organizationId,
              via: input.linkedOrganizationId ? 'EXPLICIT_ORGANIZATION' : 'EMAIL',
              repeated: true,
            },
            ...meta,
          },
          db,
        );
      }
      return db.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    });
    if (target) this.notifyAfterResponse(target, organizationId, cp.id);
    return {
      ...(await this.dto(updated, access)),
      linkRequest: CounterpartyLinkRequestOutcome.SENT_IF_ELIGIBLE,
    };
  }

  /** Withdraws a pending request or ends an accepted link (linkedOrganizationId is cleared). */
  async revokeLink(
    auth: AuthContext,
    organizationId: string,
    counterpartyId: string,
    input: RevokeCounterpartyLinkInput,
    req: Request,
  ) {
    const access = await this.orgs.authorizeWrite(auth, organizationId, Permission.TRANSACTION_CREATE, req);
    const cp = await this.loadOwn(organizationId, counterpartyId);
    const status = publicLinkStatus(cp);
    if (
      status !== CounterpartyLinkPublicStatus.REQUESTED &&
      status !== CounterpartyLinkPublicStatus.ACCEPTED
    ) {
      throw new DomainError(
        ErrorCode.LINK_NOT_PENDING,
        'There is no pending request or active link to revoke',
        HttpStatus.CONFLICT,
        { status },
      );
    }
    const target = cp.linkedOrganizationId ?? cp.linkRequestedOrganizationId;
    const now = new Date();
    const meta = requestMeta(req);
    const updated = await this.prisma.$transaction(async (db) => {
      const res = await db.counterparty.updateMany({
        where: { id: cp.id, organizationId, linkStatus: cp.linkStatus },
        data: {
          linkStatus: CounterpartyLinkStatus.REVOKED,
          linkedOrganizationId: null,
          linkDecidedAt: now,
          linkDecidedByUserId: auth.userId,
        },
      });
      if (res.count === 0) {
        throw new DomainError(ErrorCode.LINK_NOT_PENDING, 'The link changed meanwhile', HttpStatus.CONFLICT);
      }
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: 'counterparty.link_revoked',
          entityType: 'Counterparty',
          entityId: cp.id,
          metadata: {
            from: status,
            reason: input.reason ?? null,
            support: access.via === 'STAFF_SUPPORT',
          },
          ...meta,
        },
        db,
      );
      if (target && cp.linkStatus !== CounterpartyLinkStatus.NONE) {
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: target,
            action: 'counterparty.link_revoked',
            entityType: 'Counterparty',
            entityId: cp.id,
            metadata: { requesterOrganizationId: organizationId, from: cp.linkStatus },
            ...meta,
          },
          db,
        );
      }
      return db.counterparty.findUniqueOrThrow({ where: { id: cp.id } });
    });
    if (target && cp.linkStatus !== CounterpartyLinkStatus.NONE) {
      const requester = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true },
      });
      const name = requester?.name ?? 'Une organisation';
      const wasLinked = cp.linkStatus === CounterpartyLinkStatus.ACCEPTED;
      await this.notifications.notifyMany(await this.decisionMakers(target), {
        type: 'counterparty.link_revoked',
        title: wasLinked ? `${name} a mis fin à la liaison client` : `${name} a retiré sa demande de liaison`,
        body: wasLinked
          ? `${name} a mis fin à la liaison : ses factures et devis ne vous sont plus visibles. ${SANDBOX_NOTE}`
          : `${name} a retiré sa demande de liaison client. ${SANDBOX_NOTE}`,
        data: { organizationId: target, counterpartyId: cp.id },
      });
    }
    return this.dto(updated, access);
  }

  // ───────────────────────────── Target side ────────────────────────────────

  async listRequests(auth: AuthContext, organizationId: string, query: ListLinkRequestsQuery) {
    // Members need ORG_LINK_DECIDE; staff may read (never decide).
    const access = this.orgs.assertMember(auth, organizationId, Permission.ORG_LINK_DECIDE, 'read');
    const canDecide = access.via === 'MEMBERSHIP';
    const where =
      query.status === CounterpartyLinkStatus.ACCEPTED
        ? { linkStatus: CounterpartyLinkStatus.ACCEPTED, linkedOrganizationId: organizationId }
        : { linkStatus: query.status, linkRequestedOrganizationId: organizationId };
    const rows = await this.prisma.counterparty.findMany({
      where,
      include: { organization: { select: { id: true, name: true, type: true, country: true } } },
      orderBy: [{ linkRequestedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return {
      organizationId,
      status: query.status,
      items: rows.map((r) => toLinkRequestDto(r, canDecide)),
      sandbox: true as const,
    };
  }

  async accept(
    auth: AuthContext,
    organizationId: string,
    counterpartyId: string,
    input: DecideCounterpartyLinkInput,
    req: Request,
  ) {
    return this.decide(auth, organizationId, counterpartyId, CounterpartyLinkStatus.ACCEPTED, input, req);
  }

  async decline(
    auth: AuthContext,
    organizationId: string,
    counterpartyId: string,
    input: DecideCounterpartyLinkInput,
    req: Request,
  ) {
    return this.decide(auth, organizationId, counterpartyId, CounterpartyLinkStatus.DECLINED, input, req);
  }

  /** Consent is a tenant decision: real OWNER / ADMIN members only (staff support gets 403). */
  private async decide(
    auth: AuthContext,
    organizationId: string,
    counterpartyId: string,
    decision: typeof CounterpartyLinkStatus.ACCEPTED | typeof CounterpartyLinkStatus.DECLINED,
    input: DecideCounterpartyLinkInput,
    req: Request,
  ) {
    this.orgs.assertMember(auth, organizationId, Permission.ORG_LINK_DECIDE, 'write');
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: counterpartyId, linkRequestedOrganizationId: organizationId },
    });
    if (!cp) throw DomainError.notFound('Link request');
    if (cp.linkStatus !== CounterpartyLinkStatus.PENDING) {
      throw new DomainError(
        ErrorCode.LINK_NOT_PENDING,
        'This link request is no longer pending',
        HttpStatus.CONFLICT,
        {
          status: cp.linkStatus,
        },
      );
    }
    const now = new Date();
    const meta = requestMeta(req);
    const accepted = decision === CounterpartyLinkStatus.ACCEPTED;
    await this.prisma.$transaction(async (db) => {
      const res = await db.counterparty.updateMany({
        where: {
          id: cp.id,
          linkStatus: CounterpartyLinkStatus.PENDING,
          linkRequestedOrganizationId: organizationId,
        },
        data: {
          linkStatus: decision,
          linkedOrganizationId: accepted ? organizationId : null,
          linkDecidedAt: now,
          linkDecidedByUserId: auth.userId,
        },
      });
      if (res.count === 0) {
        throw new DomainError(
          ErrorCode.LINK_NOT_PENDING,
          'This link request is no longer pending',
          HttpStatus.CONFLICT,
        );
      }
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId,
          action: accepted ? 'counterparty.link_accepted' : 'counterparty.link_declined',
          entityType: 'Counterparty',
          entityId: cp.id,
          metadata: { requesterOrganizationId: cp.organizationId, note: input.note ?? null },
          ...meta,
        },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: cp.organizationId,
          action: accepted ? 'counterparty.link_accepted' : 'counterparty.link_declined',
          entityType: 'Counterparty',
          entityId: cp.id,
          metadata: { targetOrganizationId: organizationId },
          ...meta,
        },
        db,
      );
    });
    if (accepted) {
      const target = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true },
      });
      await this.notifications.notifyMany(await this.decisionMakers(cp.organizationId), {
        type: 'counterparty.link_accepted',
        title: `${target?.name ?? 'Votre client'} a accepté la liaison`,
        body: `${target?.name ?? 'Votre client'} a accepté d’être relié à la fiche client « ${cp.name} » : vos factures lui sont désormais visibles et payables depuis son portefeuille sandbox. ${SANDBOX_NOTE}`,
        data: { organizationId: cp.organizationId, counterpartyId: cp.id },
      });
    }
    const row = await this.prisma.counterparty.findUniqueOrThrow({
      where: { id: cp.id },
      include: { organization: { select: { id: true, name: true, type: true, country: true } } },
    });
    return toLinkRequestDto(row, true);
  }

  /**
   * Target side: ends an accepted link — consent can be withdrawn by the organisation that gave it.
   * The requester then sees REVOKED and the re-request cooldown applies.
   */
  async revokeAsTarget(
    auth: AuthContext,
    organizationId: string,
    counterpartyId: string,
    input: DecideCounterpartyLinkInput,
    req: Request,
  ) {
    this.orgs.assertMember(auth, organizationId, Permission.ORG_LINK_DECIDE, 'write');
    const cp = await this.prisma.counterparty.findFirst({
      where: {
        id: counterpartyId,
        linkedOrganizationId: organizationId,
        linkStatus: CounterpartyLinkStatus.ACCEPTED,
      },
    });
    if (!cp) throw DomainError.notFound('Link');
    const now = new Date();
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      const res = await db.counterparty.updateMany({
        where: {
          id: cp.id,
          linkStatus: CounterpartyLinkStatus.ACCEPTED,
          linkedOrganizationId: organizationId,
        },
        data: {
          linkStatus: CounterpartyLinkStatus.REVOKED,
          linkedOrganizationId: null,
          linkRequestedOrganizationId: organizationId,
          linkDecidedAt: now,
          linkDecidedByUserId: auth.userId,
        },
      });
      if (res.count === 0) {
        throw new DomainError(ErrorCode.LINK_NOT_PENDING, 'The link changed meanwhile', HttpStatus.CONFLICT);
      }
      for (const [org, metadata] of [
        [
          organizationId,
          { requesterOrganizationId: cp.organizationId, by: 'TARGET', note: input.note ?? null },
        ],
        [cp.organizationId, { targetOrganizationId: organizationId, by: 'TARGET' }],
      ] as const) {
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: org,
            action: 'counterparty.link_revoked',
            entityType: 'Counterparty',
            entityId: cp.id,
            metadata,
            ...meta,
          },
          db,
        );
      }
    });
    const target = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });
    await this.notifications.notifyMany(await this.decisionMakers(cp.organizationId), {
      type: 'counterparty.link_revoked',
      title: `${target?.name ?? 'Votre client'} a mis fin à la liaison`,
      body: `${target?.name ?? 'Votre client'} a mis fin à la liaison avec la fiche client « ${cp.name} » : vos factures et devis ne lui sont plus visibles ni payables. ${SANDBOX_NOTE}`,
      data: { organizationId: cp.organizationId, counterpartyId: cp.id },
    });
    const row = await this.prisma.counterparty.findUniqueOrThrow({
      where: { id: cp.id },
      include: { organization: { select: { id: true, name: true, type: true, country: true } } },
    });
    return toLinkRequestDto(row, true);
  }
}
