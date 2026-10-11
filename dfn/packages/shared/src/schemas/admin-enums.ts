export { GlobalRole, RiskAlertStatus } from '../enums';
export const UserStatusEnum = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DEACTIVATED: 'DEACTIVATED',
} as const;
export type UserStatusEnum = (typeof UserStatusEnum)[keyof typeof UserStatusEnum];
