import { HttpStatus, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AttemptLockout, type AttemptReservation } from './attempt-lockout';

/** Wrong passwords (or passkey sign-ins) tolerated per account before it is locked. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export type PasswordCheck = { ok: true } | { ok: false; failures: number; locked: boolean };

/**
 * The login lockout (`failedLoginCount` / `lockedUntil`), shared by every password check — sign-in
 * and the confirmations a signed-in session must give (MFA enrolment, passkey registration,
 * password change) — and by failed passkey sign-ins. Counted per account, whatever the session or
 * the IP, so a hijacked session cannot use a confirmation form as an unlimited password oracle:
 * MAX_FAILED_LOGINS wrong attempts in a row lock all of them for LOCK_MINUTES (423 ACCOUNT_LOCKED);
 * a right password resets the counter. Attempts are reserved before the check (AttemptLockout).
 */
@Injectable()
export class LoginAttemptsService {
  private readonly attempts: AttemptLockout;

  constructor(prisma: PrismaService) {
    this.attempts = new AttemptLockout(prisma, {
      count: 'failedLoginCount',
      lockedUntil: 'lockedUntil',
      max: MAX_FAILED_LOGINS,
      lockMinutes: LOCK_MINUTES,
    });
  }

  /** 423 ACCOUNT_LOCKED; `justLocked` when the current attempt is the one that locked the account. */
  lockedError(justLocked = false) {
    return new DomainError(
      ErrorCode.ACCOUNT_LOCKED,
      justLocked
        ? `Too many attempts. Account locked for ${LOCK_MINUTES} minutes.`
        : 'Account temporarily locked. Try again later.',
      HttpStatus.LOCKED,
    );
  }

  /** Counts an attempt before its secret is checked; 423 while the account is locked. */
  async reserve(userId: string): Promise<AttemptReservation> {
    const reservation = await this.attempts.reserve(userId);
    if (!reservation) throw this.lockedError();
    return reservation;
  }

  succeeded(reservation: AttemptReservation) {
    return this.attempts.succeeded(reservation);
  }

  release(reservation: AttemptReservation) {
    return this.attempts.release(reservation);
  }

  /**
   * Checks a password of the account, counted. Throws 423 while the account is locked (the
   * password is then not checked); a mismatch reports the failures of the window and whether it
   * has just locked the account — the caller audits, then throws `lockedError(true)` or its own
   * error.
   */
  async verifyPassword(user: { id: string; passwordHash: string }, password: string): Promise<PasswordCheck> {
    const reservation = await this.reserve(user.id);
    const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!ok) return { ok: false, failures: reservation.attempt, locked: reservation.lockedUntil !== null };
    await this.attempts.succeeded(reservation);
    return { ok: true };
  }
}
