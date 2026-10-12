import { GlobalRole, OrgRole } from './enums';

/**
 * RBAC matrix — the single source of truth for authorisation decisions.
 * Server-side guards evaluate these; the web app only uses them to hide
 * controls the user cannot use (never as a security boundary).
 */
export const Permission = {
  TRANSACTION_CREATE: 'transaction:create',
  TRANSACTION_READ: 'transaction:read',
  /**
   * Every state-changing action of a Protect party, buyer or seller side: join a transaction, accept
   * its terms, request the escrow funding, submit / review / approve a milestone (approval releases
   * escrow), resend the invitation, cancel. Being a member of a party organisation is not enough.
   */
  TRANSACTION_MANAGE: 'transaction:manage',
  DOCUMENT_UPLOAD: 'document:upload',
  DISPUTE_OPEN: 'dispute:open',
  ORG_MANAGE_MEMBERS: 'org:manage_members',
  ORG_MANAGE_SETTINGS: 'org:manage_settings',
  ORG_VIEW_REPORTS: 'org:view_reports',
  WALLET_READ: 'wallet:read',
  ADMIN_USERS: 'admin:users',
  ADMIN_VERIFICATIONS: 'admin:verifications',
  ADMIN_DISPUTES: 'admin:disputes',
  ADMIN_RISK: 'admin:risk',
  ADMIN_LEDGER: 'admin:ledger',
  ADMIN_AUDIT: 'admin:audit',
  SANDBOX_PARTNER_SIMULATE: 'sandbox:partner_simulate',
  BENEFICIARY_MANAGE: 'beneficiary:manage',
  TRANSFER_CREATE: 'transfer:create',
  TRANSFER_AUTHORIZE: 'transfer:authorize',
  INVOICE_MANAGE: 'invoice:manage',
  API_MANAGE: 'api:manage',
  ADMIN_TRANSFERS: 'admin:transfers',
  ADMIN_JOBS: 'admin:jobs',
  ADMIN_DDA: 'admin:dda',
  // Phase 6
  /** Accept or decline a counterparty link request addressed to the organisation. */
  ORG_LINK_DECIDE: 'org:link_decide',
  /** Read the regulatory gates register (R1–R10). */
  ADMIN_GATES_VIEW: 'admin:gates_view',
  /** Update / approve regulatory gates (two distinct approvers required to satisfy a gate). */
  ADMIN_GATES_MANAGE: 'admin:gates_manage',
  /** Staff write access inside a tenant (support actions); staff are read-only by default. */
  ADMIN_SUPPORT_WRITE: 'admin:support_write',
  /** Key ring status and re-encryption (key rotation) operations. */
  ADMIN_KEYS: 'admin:keys',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ORG_ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  OWNER: [
    Permission.TRANSACTION_CREATE,
    Permission.TRANSACTION_READ,
    Permission.TRANSACTION_MANAGE,
    Permission.DOCUMENT_UPLOAD,
    Permission.DISPUTE_OPEN,
    Permission.ORG_MANAGE_MEMBERS,
    Permission.ORG_MANAGE_SETTINGS,
    Permission.ORG_VIEW_REPORTS,
    Permission.WALLET_READ,
    Permission.BENEFICIARY_MANAGE,
    Permission.TRANSFER_CREATE,
    Permission.TRANSFER_AUTHORIZE,
    Permission.INVOICE_MANAGE,
    Permission.API_MANAGE,
    Permission.ORG_LINK_DECIDE,
  ],
  ADMIN: [
    Permission.TRANSACTION_CREATE,
    Permission.TRANSACTION_READ,
    Permission.TRANSACTION_MANAGE,
    Permission.DOCUMENT_UPLOAD,
    Permission.DISPUTE_OPEN,
    Permission.ORG_MANAGE_MEMBERS,
    Permission.ORG_VIEW_REPORTS,
    Permission.WALLET_READ,
    Permission.BENEFICIARY_MANAGE,
    Permission.TRANSFER_CREATE,
    Permission.TRANSFER_AUTHORIZE,
    Permission.INVOICE_MANAGE,
    Permission.API_MANAGE,
    Permission.ORG_LINK_DECIDE,
  ],
  /**
   * Day-to-day operator — it moves money: runs Protect transactions (funding and escrow release
   * included), pays invoices from the wallet and drafts transfers (authorising them stays with
   * OWNER / ADMIN).
   */
  MEMBER: [
    Permission.TRANSACTION_CREATE,
    Permission.TRANSACTION_READ,
    Permission.TRANSACTION_MANAGE,
    Permission.DOCUMENT_UPLOAD,
    Permission.DISPUTE_OPEN,
    Permission.WALLET_READ,
    Permission.TRANSFER_CREATE,
    Permission.INVOICE_MANAGE,
  ],
  /** Read-only: the only role a staff support write may grant (no money movement). */
  VIEWER: [Permission.TRANSACTION_READ, Permission.WALLET_READ, Permission.ORG_VIEW_REPORTS],
};

export const GLOBAL_ROLE_PERMISSIONS: Record<GlobalRole, Permission[]> = {
  USER: [],
  COMPLIANCE: [
    Permission.ADMIN_VERIFICATIONS,
    Permission.ADMIN_DISPUTES,
    Permission.ADMIN_RISK,
    Permission.ADMIN_AUDIT,
    Permission.ADMIN_LEDGER,
    Permission.ADMIN_TRANSFERS,
    Permission.ADMIN_JOBS,
    Permission.ADMIN_GATES_VIEW,
  ],
  ADMIN: [
    Permission.ADMIN_USERS,
    Permission.ADMIN_VERIFICATIONS,
    Permission.ADMIN_DISPUTES,
    Permission.ADMIN_RISK,
    Permission.ADMIN_LEDGER,
    Permission.ADMIN_AUDIT,
    Permission.SANDBOX_PARTNER_SIMULATE,
    Permission.ADMIN_TRANSFERS,
    Permission.ADMIN_JOBS,
    Permission.ADMIN_DDA,
    Permission.ADMIN_GATES_VIEW,
    Permission.ADMIN_GATES_MANAGE,
    Permission.ADMIN_SUPPORT_WRITE,
    Permission.ADMIN_KEYS,
  ],
};

export function orgRoleHas(role: OrgRole, permission: Permission): boolean {
  return ORG_ROLE_PERMISSIONS[role].includes(permission);
}

export function globalRoleHas(role: GlobalRole, permission: Permission): boolean {
  return GLOBAL_ROLE_PERMISSIONS[role].includes(permission);
}

export function isStaff(role: GlobalRole): boolean {
  return role === GlobalRole.ADMIN || role === GlobalRole.COMPLIANCE;
}
