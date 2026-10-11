import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthCleanupService } from './auth-cleanup.service';
import { MfaVerifierService } from './mfa-verifier.service';
import { PasskeysController } from './passkeys.controller';
import { PasskeysService } from './passkeys.service';
import { RecoveryCodesService } from './recovery-codes.service';
import { SessionService } from './session.service';
import { WebAuthnService } from './webauthn.service';
import { UsersModule } from '../users/users.module';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * AuthModule — sessions, password login, TOTP MFA with anti-replay and recovery codes, passkeys
 * (WebAuthn: registration, passwordless login, step-up) and the AUTH_CLEANUP maintenance job.
 * Global: `MfaVerifierService` is the single second-factor check used by every step-up protected
 * operation (transfer authorisation, security preferences, passkey revocation, MFA disable).
 */
@Global()
@Module({
  imports: [UsersModule, OrganizationsModule],
  controllers: [AuthController, PasskeysController],
  providers: [
    AuthService,
    SessionService,
    WebAuthnService,
    RecoveryCodesService,
    MfaVerifierService,
    PasskeysService,
    AuthCleanupService,
  ],
  exports: [AuthService, SessionService, MfaVerifierService],
})
export class AuthModule {}
