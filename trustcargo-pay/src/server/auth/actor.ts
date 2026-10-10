import type { PlatformRole } from '@/domain/model';

/** Authenticated principal, resolved server-side from the session. Never built from client input. */
export interface Actor {
    kind: 'USER';
    userId: string;
    email: string;
    /**
     * EFFECTIVE platform roles. getActor() only sets them when the session passed an MFA challenge within the
     * security settings' adminMfaMaxAgeMinutes; every staff-only service check requires that recent MFA again.
     */
    platformRoles: PlatformRole[];
    /** Roles the account holds that wait for a recent MFA challenge: they grant nothing (navigation and redirects only). */
    pendingPlatformRoles?: PlatformRole[];
    /** Time of the last successful MFA challenge for this session. */
    mfaVerifiedAt?: string;
    sessionId: string;
}

export interface SystemActor {
    kind: 'SYSTEM' | 'PROVIDER';
    id: string;
}

export type AnyActor = Actor | SystemActor;

export const SYSTEM: SystemActor = { kind: 'SYSTEM', id: 'system' };

export function hasRole(actor: Actor, ...roles: PlatformRole[]): boolean {
    return roles.some((r) => actor.platformRoles.includes(r));
}

export function isStaff(actor: Actor): boolean {
    return actor.platformRoles.length > 0;
}

/** Every platform role the account holds, effective or awaiting MFA. For navigation and redirects, never for authorisation. */
export function heldPlatformRoles(actor: Actor): PlatformRole[] {
    return [...actor.platformRoles, ...(actor.pendingPlatformRoles ?? [])];
}

/** Staff roles allowed to read transaction files (read-only). platform_admin is deliberately excluded. */
export const TRANSACTION_READER_ROLES: PlatformRole[] = [
    'compliance_analyst',
    'dispute_manager',
    'auditor',
    'finance_operator',
    'document_reviewer'
];

export function mfaIsRecent(actor: Actor, maxAgeMinutes: number, now: Date): boolean {
    if (!actor.mfaVerifiedAt) return false;
    return now.getTime() - new Date(actor.mfaVerifiedAt).getTime() <= maxAgeMinutes * 60_000;
}
