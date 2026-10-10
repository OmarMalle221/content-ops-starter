import type { Db, UnitOfWork } from '@/server/ports/db';
import type { PaymentProvider } from '@/server/ports/payment-provider';
import type {
    Clock,
    FileScanner,
    FileStorage,
    IdentityVerificationProvider,
    IdGenerator,
    ScreeningProvider
} from '@/server/ports/providers';
import type { AnyActor, Actor } from '@/server/auth/actor';
import { TRANSACTION_READER_ROLES, hasRole, mfaIsRecent } from '@/server/auth/actor';
import type { PartyRole, PlatformRole, SecuritySettings, Transaction, TransactionParty } from '@/domain/model';
import { canonicalJson } from '@/domain/canonical';
import { sha256Hex } from '@/server/security/crypto';
import { storableValue } from '@/server/text';
import { AppError, forbidden, notFound } from '@/server/errors';

/** Matches the SQL schema's genesis value for the audit hash chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AppConfig {
    mode: 'demo' | 'production';
    sessionSecret: string;
    appUrl: string;
}

export interface Deps {
    uow: UnitOfWork;
    clock: Clock;
    ids: IdGenerator;
    payments: PaymentProvider;
    identity: IdentityVerificationProvider;
    screening: ScreeningProvider;
    storage: FileStorage;
    scanner: FileScanner;
    config: AppConfig;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
    adminMfaMaxAgeMinutes: 12 * 60,
    sensitiveActionMfaMaxAgeMinutes: 15,
    payoutAccountCoolingOffHours: 72,
    invitationTtlHours: 7 * 24,
    signedUrlTtlSeconds: 300,
    maxUploadBytes: 10 * 1024 * 1024,
    updatedAt: new Date(0).toISOString()
};

export async function securitySettings(db: Db): Promise<SecuritySettings> {
    return (await db.securitySettings.get('default')) ?? DEFAULT_SECURITY_SETTINGS;
}

export function actorRef(actor: AnyActor): { actorType: 'USER' | 'SYSTEM' | 'PROVIDER'; actorId?: string } {
    if (actor.kind === 'USER') return { actorType: 'USER', actorId: actor.userId };
    return { actorType: actor.kind, actorId: actor.id };
}

/** Appends a tamper-evident (hash-chained) audit event. Metadata must not contain secrets. */
export async function audit(
    deps: Deps,
    db: Db,
    actor: AnyActor,
    action: string,
    entity: { type: string; id: string },
    options: { transactionId?: string; metadata?: Record<string, unknown> } = {}
) {
    const sequence = await db.nextSequence('audit');
    const previous = sequence > 1 ? await db.auditEvents.findOne({ sequence: sequence - 1 }) : undefined;
    const previousHash = previous?.hash ?? AUDIT_GENESIS_HASH;
    const body = {
        id: deps.ids.id(),
        sequence,
        at: deps.clock.now().toISOString(),
        ...actorRef(actor),
        action,
        entityType: entity.type,
        entityId: entity.id,
        transactionId: options.transactionId,
        // Hashed as stored: the adapters' storable-text rule is applied before hashing, not after.
        metadata: storableValue(options.metadata ?? {}, 'metadata')
    };
    const hash = sha256Hex(previousHash + canonicalJson(body));
    return db.auditEvents.insert({ ...body, previousHash, hash });
}

export async function notify(
    deps: Deps,
    db: Db,
    userId: string | undefined,
    type: string,
    params: Record<string, string> = {},
    transactionId?: string
) {
    if (!userId) return;
    await db.notifications.insert({ id: deps.ids.id(), userId, type, params, transactionId, createdAt: deps.clock.now().toISOString() });
}

export async function notifyRole(
    deps: Deps,
    db: Db,
    role: PlatformRole,
    type: string,
    params: Record<string, string>,
    transactionId?: string
) {
    const users = (await db.users.list()).filter((u) => u.platformRoles.includes(role));
    for (const u of users) await notify(deps, db, u.id, type, params, transactionId);
}

/**
 * Back-office rule, enforced by the services themselves and not only by the /admin pages: a platform role is only
 * effective with an MFA challenge passed within the security settings' adminMfaMaxAgeMinutes. getActor() already
 * withholds the roles of a session without one (pendingPlatformRoles); this check also holds for an actor built by
 * hand. Party access (owner, JOINED party, organisation member) needs no MFA.
 */
export async function staffMfaIsRecent(db: Db, actor: Actor, now: Date): Promise<boolean> {
    return mfaIsRecent(actor, (await securitySettings(db)).adminMfaMaxAgeMinutes, now);
}

const staffMfaRequired = () => new AppError('MFA_REQUIRED', 'A recent MFA verification is required for back-office access');

/**
 * Staff-only operations: one of `roles`, effective. FORBIDDEN without the role; MFA_REQUIRED when the role is held
 * without a recent MFA (stale session, or an actor whose roles are pending). Runs in `db` when given.
 */
export async function requireStaffRole(deps: Deps, actor: Actor, roles: PlatformRole[], db?: Db): Promise<void> {
    if (!hasRole(actor, ...roles)) {
        if (roles.some((r) => actor.pendingPlatformRoles?.includes(r))) throw staffMfaRequired();
        throw forbidden();
    }
    const recent = (d: Db) => staffMfaIsRecent(d, actor, deps.clock.now());
    if (!(await (db ? recent(db) : deps.uow.run(recent)))) throw staffMfaRequired();
}

export interface TransactionAccess {
    tx: Transaction;
    party?: TransactionParty;
    /** Read-only access through an organisation membership or a staff role. */
    viaOrganization: boolean;
    staff: boolean;
}

/**
 * Central authorisation check for transaction-scoped operations.
 * Unknown or inaccessible transactions both yield NOT_FOUND so existence is not leaked.
 * The read-only staff fallback requires a recent MFA (staffMfaIsRecent), measured at `now` (default: the wall clock,
 * like the session's MFA stamp).
 */
export async function accessTransaction(
    db: Db,
    actor: Actor,
    transactionId: string,
    options: { roles?: PartyRole[]; write?: boolean; staffRoles?: PlatformRole[]; now?: Date } = {}
): Promise<TransactionAccess> {
    const tx = await db.transactions.get(transactionId);
    if (!tx) throw notFound('Transaction');
    const parties = await db.transactionParties.findBy({ transactionId });
    const party = parties.find((p) => p.userId === actor.userId && p.status === 'JOINED');
    if (party) {
        if (options.roles && !options.roles.includes(party.role)) {
            throw new AppError('FORBIDDEN', `This action requires one of the roles: ${options.roles.join(', ')}`);
        }
        return { tx, party, viaOrganization: false, staff: false };
    }
    if (!options.write) {
        const memberships = await db.organizationMembers.findBy({ userId: actor.userId });
        const orgIds = new Set(memberships.map((m) => m.organizationId));
        const orgParty = parties.find((p) => p.organizationId && orgIds.has(p.organizationId) && p.status === 'JOINED');
        if (orgParty && (!options.roles || options.roles.includes(orgParty.role))) {
            return { tx, party: undefined, viaOrganization: true, staff: false };
        }
        if (hasRole(actor, ...(options.staffRoles ?? TRANSACTION_READER_ROLES))) {
            if (!(await staffMfaIsRecent(db, actor, options.now ?? new Date()))) throw staffMfaRequired();
            return { tx, party: undefined, viaOrganization: false, staff: true };
        }
    }
    throw notFound('Transaction');
}

export function requireUser(actor: AnyActor): Actor {
    if (actor.kind !== 'USER') throw new AppError('FORBIDDEN', 'User actor required');
    return actor;
}
