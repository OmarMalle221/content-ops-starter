import { SetMetadata } from '@nestjs/common';
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
/** Allows access with a session that has not completed the MFA challenge yet. */
export const ALLOW_PRE_MFA_KEY = 'allowPreMfa';
export const AllowPreMfa = () => SetMetadata(ALLOW_PRE_MFA_KEY, true);
