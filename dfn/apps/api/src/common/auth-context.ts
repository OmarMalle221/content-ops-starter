import type { GlobalRole, OrgRole } from '@dfn/database';

export interface AuthMembership {
  organizationId: string;
  organizationName: string;
  organizationType: 'PERSONAL' | 'BUSINESS';
  role: OrgRole;
}

/** Present when the request was authenticated with a partner API key (Diaspora API). */
export interface AuthApiCredential {
  id: string;
  scopes: string[];
  organizationId: string;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  firstName: string;
  lastName: string;
  locale: string;
  globalRole: GlobalRole;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  memberships: AuthMembership[];
  ip?: string;
  userAgent?: string;
  /** Set only for API-key authenticated requests; absent for cookie / bearer-session requests. */
  apiCredential?: AuthApiCredential;
}

export function isStaff(auth: AuthContext): boolean {
  return auth.globalRole === 'ADMIN' || auth.globalRole === 'COMPLIANCE';
}

export function membershipFor(auth: AuthContext, organizationId: string): AuthMembership | undefined {
  return auth.memberships.find((m) => m.organizationId === organizationId);
}
