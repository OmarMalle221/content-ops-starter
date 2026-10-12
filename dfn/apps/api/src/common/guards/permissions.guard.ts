import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, globalRoleHas, type Permission } from '@dfn/shared';
import { DomainError } from '../domain-error';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import type { AuthContext } from '../auth-context';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const auth = context.switchToHttp().getRequest().auth as AuthContext | undefined;
    if (!auth) throw DomainError.forbidden();
    const ok = required.every((p) => globalRoleHas(auth.globalRole, p));
    if (ok) return true;
    // REQUIRE_STAFF_MFA: the session resolved a staff account without MFA to USER rights.
    if (auth.staffMfaRequired) {
      throw new DomainError(
        ErrorCode.STAFF_MFA_REQUIRED,
        'Enable two-factor authentication to use staff permissions',
        HttpStatus.FORBIDDEN,
      );
    }
    throw DomainError.forbidden('Insufficient privileges');
  }
}
