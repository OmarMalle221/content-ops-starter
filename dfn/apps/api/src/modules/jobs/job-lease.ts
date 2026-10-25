import type { MaintenanceJobName, PrismaClient } from '@dfn/database';

/** A row of JobLease, as exposed to the admin console. */
export interface JobLeaseDto {
  jobName: MaintenanceJobName;
  ownerId: string;
  runId: string | null;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  /** Computed with the database clock (the only clock leases are compared against). */
  expired: boolean;
}

/** Previous holder of a lease that was taken over because it had expired. */
export interface TakenOverLease {
  ownerId: string;
  runId: string | null;
}

export interface LeaseAcquisition {
  /** Set when the lease existed and had expired (a crashed or partitioned replica). */
  takenOver: TakenOverLease | null;
}

/** Heartbeat period: three renewals per lease, never more often than every 250 ms. */
export function heartbeatIntervalMs(leaseSeconds: number): number {
  return Math.max(250, Math.floor((leaseSeconds * 1000) / 3));
}

/**
 * Time-bounded, renewable job ownership in the JobLease table (one row per job name).
 *
 *  - acquire: a single INSERT … ON CONFLICT (jobName) DO UPDATE … WHERE expiresAt < now() —
 *    inserts a free lease, takes over an expired one, and does nothing when a live owner holds
 *    it. PostgreSQL row locking makes concurrent acquisitions race-free: exactly one wins.
 *  - renew: UPDATE … WHERE ownerId = me AND runId = mine (fails once someone took it over).
 *  - release: DELETE … WHERE ownerId = me AND runId = mine (never removes another owner's lease).
 *
 * Every timestamp comes from the database clock (`now() AT TIME ZONE 'UTC'`, the columns are
 * UTC `timestamp(3)`), so replicas with skewed clocks still agree on expiry.
 */
export class JobLeaseStore {
  constructor(
    private readonly prisma: PrismaClient,
    readonly ownerId: string,
    readonly leaseSeconds: number,
  ) {}

  /** Null when another live owner holds the lease. */
  async acquire(jobName: MaintenanceJobName, runId: string): Promise<LeaseAcquisition | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ previousOwnerId: string | null; previousRunId: string | null }>
    >`
      WITH previous AS (
        SELECT "ownerId", "runId" FROM "JobLease" WHERE "jobName" = ${jobName}::"MaintenanceJobName"
      )
      INSERT INTO "JobLease" ("jobName", "ownerId", "runId", "acquiredAt", "heartbeatAt", "expiresAt")
      VALUES (
        ${jobName}::"MaintenanceJobName",
        ${this.ownerId},
        ${runId}::uuid,
        (now() AT TIME ZONE 'UTC'),
        (now() AT TIME ZONE 'UTC'),
        (now() AT TIME ZONE 'UTC') + make_interval(secs => ${this.leaseSeconds}::double precision)
      )
      ON CONFLICT ("jobName") DO UPDATE SET
        "ownerId" = EXCLUDED."ownerId",
        "runId" = EXCLUDED."runId",
        "acquiredAt" = EXCLUDED."acquiredAt",
        "heartbeatAt" = EXCLUDED."heartbeatAt",
        "expiresAt" = EXCLUDED."expiresAt"
      WHERE "JobLease"."expiresAt" < (now() AT TIME ZONE 'UTC')
      RETURNING
        (SELECT "ownerId" FROM previous) AS "previousOwnerId",
        (SELECT "runId"::text FROM previous) AS "previousRunId"`;
    const row = rows[0];
    if (!row) return null;
    return {
      takenOver: row.previousOwnerId ? { ownerId: row.previousOwnerId, runId: row.previousRunId } : null,
    };
  }

  /** Extends the lease by `leaseSeconds` from now; false when this run no longer owns it. */
  async renew(jobName: MaintenanceJobName, runId: string): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "JobLease"
      SET "heartbeatAt" = (now() AT TIME ZONE 'UTC'),
          "expiresAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${this.leaseSeconds}::double precision)
      WHERE "jobName" = ${jobName}::"MaintenanceJobName"
        AND "ownerId" = ${this.ownerId}
        AND "runId" = ${runId}::uuid`;
    return count === 1;
  }

  /** Deletes the lease only if this owner (and, when given, this run) still holds it. */
  async release(jobName: MaintenanceJobName, runId?: string): Promise<boolean> {
    const { count } = await this.prisma.jobLease.deleteMany({
      where: { jobName, ownerId: this.ownerId, ...(runId ? { runId } : {}) },
    });
    return count > 0;
  }

  async get(jobName: MaintenanceJobName): Promise<JobLeaseDto | null> {
    const rows = await this.query(jobName);
    return rows[0] ?? null;
  }

  async list(): Promise<JobLeaseDto[]> {
    return this.query();
  }

  private query(jobName?: MaintenanceJobName): Promise<JobLeaseDto[]> {
    return jobName
      ? this.prisma.$queryRaw<JobLeaseDto[]>`
          SELECT "jobName", "ownerId", "runId"::text AS "runId", "acquiredAt", "heartbeatAt", "expiresAt",
                 ("expiresAt" < (now() AT TIME ZONE 'UTC')) AS "expired"
          FROM "JobLease" WHERE "jobName" = ${jobName}::"MaintenanceJobName"`
      : this.prisma.$queryRaw<JobLeaseDto[]>`
          SELECT "jobName", "ownerId", "runId"::text AS "runId", "acquiredAt", "heartbeatAt", "expiresAt",
                 ("expiresAt" < (now() AT TIME ZONE 'UTC')) AS "expired"
          FROM "JobLease" ORDER BY "jobName"`;
  }
}
