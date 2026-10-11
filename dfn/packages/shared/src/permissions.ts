import { GlobalRole, OrgRole } from './enums';

/**
 * RBAC matrix — the single source of truth for authorisation decisions.
 * Server-side guards evaluate these; the web app only uses them to hide
 * controls the user cannot use (never as a security boundary).
 */
export const Permission = {
  TRANSACTION_CREATE: 'transaction:create',
  TRANSACTION_READ: 'transaction:read',
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
  ],
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
