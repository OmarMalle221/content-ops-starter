import { Prisma } from '@dfn/database';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * A per-account attempt counter stored on "User": its two columns, the attempts allowed per window
 * and the lock length. Column names come only from this closed list, never from input.
 */
export interface AttemptCounter {
  count: 'failedLoginCount' | 'mfaFailedCount';
  lockedUntil: 'lockedUntil' | 'mfaLockedUntil';
  max: number;
  lockMinutes: number;
}

/** One attempt reserved by `AttemptLockout.reserve`, settled once the secret has been checked. */
export interface AttemptReservation {
  userId: string;
  /** Rank of this attempt in the current window (1 … max). */
  attempt: number;
  /** The lock placed by the last allowed attempt of the window (`attempt === max`), else null. */
  lockedUntil: Date | null;
}

/**
 * Per-account lockout that a burst of parallel requests cannot outrun: the attempt is counted
 * atomically (one `UPDATE … RETURNING`) BEFORE the secret is checked, so at most `max` secrets are
 * checked per lock window however many requests race (a "not locked" read followed by a check
 * would let every request of the burst through).
 *
 * - `reserve` returns null while the lock is active (the secret must then not be checked); an
 *   expired lock starts a fresh window;
 * - the attempt that reaches `max` places the lock itself: concurrent requests are refused while
 *   it is checked, and a crash between reservation and outcome still leaves a lock that expires;
 * - a wrong secret keeps its attempt counted, nothing to write: when it was the last one
 *   (`lockedUntil` set) the account is now locked;
 * - `succeeded` resets the counter and lifts only the lock this attempt placed — a lock placed by
 *   a concurrent wrong attempt stands;
 * - `release` gives back an attempt that was not a guess (e.g. a replayed valid TOTP code).
 *
 * Raw SQL so the read-modify-write is a single statement; times use the database clock in UTC like
 * the Prisma DateTime columns. `updatedAt` is left untouched (bookkeeping, not a profile change).
 */
export class AttemptLockout {
  private readonly count: Prisma.Sql;
  private readonly lockedUntil: Prisma.Sql;

  constructor(
    private readonly prisma: PrismaService,
    private readonly counter: AttemptCounter,
  ) {
    this.count = Prisma.raw(`"${counter.count}"`);
    this.lockedUntil = Prisma.raw(`"${counter.lockedUntil}"`);
  }

  async reserve(userId: string): Promise<AttemptReservation | null> {
    const { count, lockedUntil } = this;
    const { max, lockMinutes } = this.counter;
    // Every expression reads the row as it was before the update. A lock still recorded once the
    // WHERE clause passed has expired, and a counter at max without a lock was left by a lock
    // lifted by hand: in both cases the window restarts at 1.
    const rows = await this.prisma.$queryRaw<Array<{ attempt: number; lockedUntil: Date | null }>>`
      UPDATE "User"
      SET ${count} = CASE WHEN ${lockedUntil} IS NULL AND ${count} < ${max} THEN ${count} + 1 ELSE 1 END,
          ${lockedUntil} = CASE WHEN ${lockedUntil} IS NULL AND ${count} = ${max - 1}
            THEN (now() AT TIME ZONE 'UTC') + make_interval(mins => ${lockMinutes}::int)
            ELSE NULL END
      WHERE id = ${userId}::uuid
        AND (${lockedUntil} IS NULL OR ${lockedUntil} <= (now() AT TIME ZONE 'UTC'))
      RETURNING ${count} AS "attempt", ${lockedUntil} AS "lockedUntil"`;
    const row = rows[0];
    return row ? { userId, attempt: Number(row.attempt), lockedUntil: row.lockedUntil } : null;
  }

  /** Right secret: the counter restarts (consecutive failures only). */
  async succeeded(reservation: AttemptReservation) {
    await this.prisma.$executeRaw`
      UPDATE "User" SET ${this.count} = 0${this.liftOwnLock(reservation)}
      WHERE id = ${reservation.userId}::uuid`;
  }

  /** Not a guess: the attempt is given back. */
  async release(reservation: AttemptReservation) {
    await this.prisma.$executeRaw`
      UPDATE "User" SET ${this.count} = GREATEST(${this.count} - 1, 0)${this.liftOwnLock(reservation)}
      WHERE id = ${reservation.userId}::uuid`;
  }

  /** SET fragment clearing the lock only when it is the one placed by this reservation. */
  private liftOwnLock(reservation: AttemptReservation): Prisma.Sql {
    if (!reservation.lockedUntil) return Prisma.empty;
    const { lockedUntil } = this;
    return Prisma.sql`, ${lockedUntil} = CASE WHEN ${lockedUntil} = (${reservation.lockedUntil} AT TIME ZONE 'UTC')
      THEN NULL ELSE ${lockedUntil} END`;
  }
}
