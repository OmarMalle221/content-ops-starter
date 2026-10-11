import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@dfn/shared';
export const PERMISSIONS_KEY = 'permissions';
/** Global (staff) permission requirement enforced by PermissionsGuard. */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);
