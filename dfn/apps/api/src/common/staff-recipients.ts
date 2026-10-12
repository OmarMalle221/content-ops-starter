import type { GlobalRole, Prisma, UserStatus } from '@dfn/database';
import type { Env } from '../config/env';

export type StaffRole = Exclude<GlobalRole, 'USER'>;

/** Every staff role (risk, disputes, ledger anomalies, transfer reviews). */
export const STAFF_ROLES: readonly StaffRole[] = ['ADMIN', 'COMPLIANCE'];

/**
 * Users picked by their stored role to receive staff notifications or be assigned staff work:
 * ACTIVE, not deleted, one of `roles` and — under REQUIRE_STAFF_MFA — with two-factor
 * authentication enabled. Same rule as the session (SessionService): a staff account without a
 * second factor acts with USER rights, so it must not receive staff data (risk scores, rule codes,
 * amounts, beneficiaries) nor be handed a review.
 */
export function staffUserWhere(
  env: Pick<Env, 'REQUIRE_STAFF_MFA'>,
  roles: readonly StaffRole[] = STAFF_ROLES,
): Prisma.UserWhereInput {
  return {
    status: 'ACTIVE',
    deletedAt: null,
    globalRole: { in: [...roles] },
    ...(env.REQUIRE_STAFF_MFA ? { mfaEnabled: true } : {}),
  };
}

/** In-memory twin of `staffUserWhere` for a user row already loaded (e.g. an alert's assignee). */
export function isEligibleStaff(
  env: Pick<Env, 'REQUIRE_STAFF_MFA'>,
  user: { status: UserStatus; deletedAt: Date | null; globalRole: GlobalRole; mfaEnabled: boolean },
  roles: readonly StaffRole[] = STAFF_ROLES,
): boolean {
  return (
    user.status === 'ACTIVE' &&
    !user.deletedAt &&
    (roles as readonly GlobalRole[]).includes(user.globalRole) &&
    (!env.REQUIRE_STAFF_MFA || user.mfaEnabled)
  );
}
