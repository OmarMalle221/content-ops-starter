import 'server-only';
import { Permission, orgRoleHas, type OrgRole } from '@dfn/shared';
import { getSession, type Me } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export type WorkspaceOrg = Me['user']['organizations'][number];

export interface BusinessWorkspace {
  t: (path: string) => string;
  locale: 'fr' | 'en';
  session: Me;
  orgs: WorkspaceOrg[];
  organizationId: string;
  org: WorkspaceOrg;
  myRole: string | undefined;
  isStaff: boolean;
  /** OWNER / ADMIN (or staff): members, invitations, verification. */
  canManage: boolean;
  /** INVOICE_MANAGE: create / send / cancel documents, record payments. */
  canInvoice: boolean;
  /** TRANSACTION_CREATE: create client records. */
  canCreateClients: boolean;
  /** ORG_VIEW_REPORTS. */
  canViewReports: boolean;
  /** Query string suffix carrying the selected organisation. */
  qs: string;
}

/** YYYY-MM-DD `days` from now — computed once per request on the server so client forms stay hydration-safe. */
export function isoDateInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function has(role: string | undefined, permission: Permission, isStaff: boolean): boolean {
  if (isStaff) return true;
  if (!role) return false;
  return orgRoleHas(role as OrgRole, permission);
}

/**
 * Resolves the organisation of the Diaspora Business workspace from `?organizationId=`
 * (defaults to the first BUSINESS organisation, then the personal workspace).
 */
export async function resolveWorkspace(
  searchParams: Promise<{ organizationId?: string }> | { organizationId?: string },
): Promise<BusinessWorkspace> {
  const sp = await searchParams;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const businesses = orgs.filter((o) => o.type === 'BUSINESS');
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId)
      ? sp.organizationId
      : (businesses[0]?.id ?? orgs[0].id);
  const org = orgs.find((o) => o.id === organizationId)!;
  const isStaff = session!.user.globalRole !== 'USER';
  const myRole = org.role;
  return {
    t,
    locale,
    session: session!,
    orgs,
    organizationId,
    org,
    myRole,
    isStaff,
    canManage: isStaff || myRole === 'OWNER' || myRole === 'ADMIN',
    canInvoice: has(myRole, Permission.INVOICE_MANAGE, isStaff),
    canCreateClients: has(myRole, Permission.TRANSACTION_CREATE, isStaff),
    canViewReports: has(myRole, Permission.ORG_VIEW_REPORTS, isStaff),
    qs: `organizationId=${organizationId}`,
  };
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
