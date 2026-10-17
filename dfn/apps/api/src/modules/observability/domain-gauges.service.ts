import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import {
  DocumentScanStatus,
  EncryptionKeyStatus,
  MaintenanceRunStatus,
  Prisma,
  ReconciliationStatus,
  RiskSeverity,
  TransferStatus,
  WebhookDeliveryStatus,
} from '@dfn/database';
import { KeyPurpose, RISK_ALERT_OPEN_STATUSES } from '@dfn/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JobRegistry } from '../jobs/job-registry';
import { MetricsService } from './metrics.service';

/** A scrape within this window after a refresh is served from the cached values (no query). */
export const DOMAIN_GAUGES_TTL_MS = 15_000;
/** Deadline of one refresh (all collectors): a slow database must not hold the scrape past Prometheus' own timeout. */
export const DOMAIN_GAUGES_TIMEOUT_MS = 5_000;
/** Longest wait for a pool connection: a refresh fails fast rather than queue behind the API's own requests. */
const POOL_WAIT_MS = 1_000;
/** Client-side grace after the server-side cancellation, so that the database's own error is the one reported. */
const CANCEL_GRACE_MS = 250;

/** What a collector queries: the transaction client of withStatementTimeout(). */
export type DomainGaugesQueryClient = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'webhookDelivery'
  | 'counterparty'
  | 'transfer'
  | 'document'
  | 'encryptionKey'
  | 'reconciliationJob'
>;
/** Minimal Prisma surface the service needs (a fake can replace the real client in tests). */
export type DomainGaugesDatabase = Pick<PrismaService, '$transaction'>;

/** Optional provider token overriding the cache window and the refresh deadline (tests). */
export const DOMAIN_GAUGES_OPTIONS = Symbol('DOMAIN_GAUGES_OPTIONS');
export interface DomainGaugesOptions {
  ttlMs?: number;
  timeoutMs?: number;
}

interface Collector {
  name: string;
  gauges: Gauge[];
  /** Runs the queries; resolves with the function that writes the gauges (applied only on success). */
  run: (db: DomainGaugesQueryClient, now: Date) => Promise<() => void>;
  /** Settles when the transaction of the previous run ends; null when none is in flight (single-flight). */
  pending: Promise<void> | null;
}

const seconds = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / 1000);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Runs `fn` inside one transaction whose statements PostgreSQL cancels after `budgetMs`
 * (`statement_timeout`, local to the transaction): a query that hangs on a locked table releases
 * its connection at the deadline instead of holding it while the next scrapes pile up more. The
 * wait for a pool connection is bounded as well (the API's own requests have priority on the
 * pool), and the Prisma transaction itself a little later, as a backstop.
 */
export function withStatementTimeout<T>(
  db: DomainGaugesDatabase,
  budgetMs: number,
  fn: (tx: DomainGaugesQueryClient) => Promise<T>,
): Promise<T> {
  const ms = Math.max(1, Math.round(budgetMs));
  return db.$transaction(
    async (tx) => {
      // set_config(..., is_local = true) is SET LOCAL with a bind parameter (SET itself takes none).
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(ms)}, true)`;
      return fn(tx);
    },
    { maxWait: Math.min(ms, POOL_WAIT_MS), timeout: ms + CANCEL_GRACE_MS },
  );
}

/**
 * Gauges computed from the database at scrape time: maintenance runs, webhook backlog, review
 * queue, link requests, transfers, document scan verdicts, managed keys and ledger reconciliation.
 * All collectors share one refresh per DOMAIN_GAUGES_TTL_MS — concurrent scrapes (several
 * Prometheus servers, a replica scraped twice) await the same in-flight refresh, so scrapes cannot
 * hammer the database. Within a refresh the collectors run one at a time, each in one transaction
 * with a server-side statement_timeout (withStatementTimeout): a refresh never holds more than one
 * pool connection, a hung query is cancelled at the deadline, and a collector whose previous
 * transaction has not ended yet is skipped rather than started again. A collector that fails, times
 * out or is skipped resets its gauges (no stale value is served as current) and counts in
 * dfn_metrics_collect_errors_total; the other collectors and the HTTP / process metrics are rendered
 * regardless. Every replica reports the same database-wide values: aggregate with max()/avg()
 * across instances in dashboards and alerts.
 */
@Injectable()
export class DomainGaugesService {
  private readonly logger = new Logger(DomainGaugesService.name);
  private readonly prisma: DomainGaugesDatabase;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly collectors: Collector[];
  private snapshotAt = 0;
  private inflight: Promise<void> | null = null;
  /** Gauges declared without labels (see clear()). */
  private readonly scalarGauges = new WeakSet<Gauge>();
  private readonly snapshotAge: Gauge;
  private readonly refreshDuration: Gauge;
  /**
   * Failed refreshes by collector. Declared here, with the same collect() as the gauges, so that
   * the errors of a refresh are visible in the scrape that triggered it (prom-client reads every
   * metric of the registry concurrently: a counter without collect() would be read before the
   * gauges' refresh ran).
   */
  readonly collectErrors: Counter<'collector'>;

  constructor(
    prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly registry: JobRegistry,
    @Optional() @Inject(DOMAIN_GAUGES_OPTIONS) options?: DomainGaugesOptions,
  ) {
    this.prisma = prisma;
    this.ttlMs = options?.ttlMs ?? DOMAIN_GAUGES_TTL_MS;
    this.timeoutMs = options?.timeoutMs ?? DOMAIN_GAUGES_TIMEOUT_MS;
    this.collectErrors = new Counter({
      name: 'dfn_metrics_collect_errors_total',
      help: 'Domain gauge refreshes that failed (database error, timeout or skipped run), by collector; the other metrics are still served.',
      labelNames: ['collector'],
      registers: [this.metrics.registry],
      collect: () => this.ensureFresh(),
    });
    this.collectors = [
      this.maintenanceCollector(),
      this.webhookCollector(),
      this.reviewCollector(),
      this.linkRequestCollector(),
      this.transferCollector(),
      this.documentCollector(),
      this.encryptionKeyCollector(),
      this.reconciliationCollector(),
    ];
    this.snapshotAge = this.gauge(
      'dfn_metrics_snapshot_age_seconds',
      'Age of the cached domain gauge values served by this scrape (0 = refreshed for it).',
    );
    this.refreshDuration = this.gauge(
      'dfn_metrics_collect_duration_seconds',
      'Duration of the last refresh of the domain gauges (all collectors, run one after the other).',
    );
  }

  /** Forces the next scrape to query the database (tests, or right after a job run). */
  invalidate() {
    this.snapshotAt = 0;
  }

  /** Every domain gauge awaits this in its collect(): values are consistent within one scrape. */
  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.snapshotAt < this.ttlMs) {
      this.snapshotAge.set(seconds(new Date(this.snapshotAt), new Date()));
      return;
    }
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    await this.inflight;
    this.snapshotAge.set(seconds(new Date(this.snapshotAt), new Date()));
  }

  /** One pass over every collector, sequentially within the refresh deadline; never throws. */
  async refresh(): Promise<void> {
    const now = new Date();
    const startedAt = process.hrtime.bigint();
    const deadline = Date.now() + this.timeoutMs;
    for (const collector of this.collectors) {
      this.clear(collector);
      const budget = deadline - Date.now();
      try {
        if (collector.pending) throw new Error('previous run still pending, not started again');
        if (budget <= 0) throw new Error(`skipped: refresh deadline of ${this.timeoutMs} ms exhausted`);
        const write = await withTimeout(
          this.runCollector(collector, now, budget),
          budget + CANCEL_GRACE_MS,
          collector.name,
        );
        write();
      } catch (err) {
        this.collectErrors.inc({ collector: collector.name });
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`metrics collector ${collector.name} failed: ${message}`);
      }
    }
    this.refreshDuration.set(Number(process.hrtime.bigint() - startedAt) / 1e9);
    this.snapshotAt = Date.now();
  }

  /** Starts the collector's transaction and marks it pending until that transaction ends. */
  private runCollector(collector: Collector, now: Date, budgetMs: number): Promise<() => void> {
    const run = withStatementTimeout(this.prisma, budgetMs, (tx) => collector.run(tx, now));
    collector.pending = run
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        collector.pending = null;
      });
    return run;
  }

  /**
   * Series that no longer exist (a job never run again, a purpose without keys) disappear, and a
   * failed collector leaves no sample at all: reset() re-initialises a gauge without labels to 0,
   * which would read as a real value, so that sample is removed as well.
   */
  private clear(collector: Collector) {
    collector.gauges.forEach((g) => {
      g.reset();
      if (this.scalarGauges.has(g)) g.remove();
    });
  }

  private gauge<L extends string = string>(name: string, help: string, labelNames: L[] = []): Gauge<L> {
    const gauge = new Gauge<L>({
      name,
      help,
      labelNames,
      registers: [this.metrics.registry],
      collect: () => this.ensureFresh(),
    });
    if (labelNames.length === 0) this.scalarGauges.add(gauge as unknown as Gauge);
    return gauge;
  }

  // ── Collectors ──────────────────────────────────────────────────────────────

  private maintenanceCollector(): Collector {
    const registered = this.gauge(
      'dfn_maintenance_job_registered',
      'Maintenance jobs this replica registered with the scheduler (always 1): a registered job without a dfn_maintenance_job_last_success_age_seconds series has never succeeded.',
      ['job_name'],
    );
    const lastRunStatus = this.gauge(
      'dfn_maintenance_job_last_run_status',
      'Status of the latest MaintenanceRun of each job: 1 for its status, 0 for the others.',
      ['job_name', 'status'],
    );
    const lastRunAge = this.gauge(
      'dfn_maintenance_job_last_run_age_seconds',
      'Seconds since the latest run of each job started.',
      ['job_name'],
    );
    const lastRunDuration = this.gauge(
      'dfn_maintenance_job_last_run_duration_seconds',
      'Duration of the latest run of each job (elapsed so far when it is still RUNNING).',
      ['job_name'],
    );
    const lastSuccessAge = this.gauge(
      'dfn_maintenance_job_last_success_age_seconds',
      'Seconds since the latest COMPLETED run of each job finished (absent until a first success).',
      ['job_name'],
    );
    return {
      name: 'maintenance_runs',
      gauges: [registered, lastRunStatus, lastRunAge, lastRunDuration, lastSuccessAge],
      pending: null,
      run: async (db, now) => {
        const lastRuns = await db.$queryRaw<
          Array<{ jobName: string; status: string; startedAt: Date; finishedAt: Date | null }>
        >`
          SELECT DISTINCT ON ("jobName") "jobName"::text AS "jobName", status::text AS status,
                 "startedAt", "finishedAt"
          FROM "MaintenanceRun"
          ORDER BY "jobName", "startedAt" DESC`;
        const lastSuccesses = await db.$queryRaw<Array<{ jobName: string; finishedAt: Date }>>`
          SELECT "jobName"::text AS "jobName", MAX("finishedAt") AS "finishedAt"
          FROM "MaintenanceRun"
          WHERE status = 'COMPLETED' AND "finishedAt" IS NOT NULL
          GROUP BY "jobName"`;
        // Read at write time: the registry is filled by the feature modules' onModuleInit hooks.
        return () => {
          for (const jobName of this.registry.list()) registered.set({ job_name: jobName }, 1);
          for (const run of lastRuns) {
            for (const status of Object.values(MaintenanceRunStatus)) {
              lastRunStatus.set({ job_name: run.jobName, status }, run.status === status ? 1 : 0);
            }
            lastRunAge.set({ job_name: run.jobName }, seconds(run.startedAt, now));
            lastRunDuration.set({ job_name: run.jobName }, seconds(run.startedAt, run.finishedAt ?? now));
          }
          for (const success of lastSuccesses) {
            lastSuccessAge.set({ job_name: success.jobName }, seconds(success.finishedAt, now));
          }
        };
      },
    };
  }

  private webhookCollector(): Collector {
    const byStatus = this.gauge(
      'dfn_webhook_deliveries',
      'WebhookDelivery rows by status (PENDING and FAILED rows are the backlog).',
      ['status'],
    );
    const due = this.gauge(
      'dfn_webhook_deliveries_due',
      'Deliveries waiting for an attempt now: PENDING rows and FAILED rows whose back-off has elapsed.',
    );
    const oldestDueAge = this.gauge(
      'dfn_webhook_oldest_due_age_seconds',
      'Seconds the oldest due delivery has been waiting (0 when none is due).',
    );
    return {
      name: 'webhook_deliveries',
      gauges: [byStatus, due, oldestDueAge],
      pending: null,
      run: async (db, now) => {
        const counts = await db.webhookDelivery.groupBy({ by: ['status'], _count: { _all: true } });
        const [dueRow] = await db.$queryRaw<Array<{ due: number; oldest: Date | null }>>`
          SELECT COUNT(*)::int AS due,
                 MIN(CASE WHEN status = 'PENDING' THEN "createdAt" ELSE "nextAttemptAt" END) AS oldest
          FROM "WebhookDelivery"
          WHERE status = 'PENDING' OR (status = 'FAILED' AND "nextAttemptAt" <= ${now})`;
        return () => {
          for (const status of Object.values(WebhookDeliveryStatus)) {
            byStatus.set({ status }, counts.find((c) => c.status === status)?._count._all ?? 0);
          }
          due.set(dueRow?.due ?? 0);
          oldestDueAge.set(dueRow?.oldest ? seconds(dueRow.oldest, now) : 0);
        };
      },
    };
  }

  private reviewCollector(): Collector {
    const open = this.gauge(
      'dfn_review_alerts_open',
      'Risk alerts in the review queue (OPEN, REVIEWING, CONTESTED), by severity.',
      ['severity'],
    );
    const breached = this.gauge(
      'dfn_review_alerts_sla_breached',
      'Open alerts marked past their SLA by the REVIEW_SLA job, by severity.',
      ['severity'],
    );
    const overdue = this.gauge(
      'dfn_review_alerts_overdue',
      'Open alerts whose dueAt has passed (computed now, before the REVIEW_SLA job marks them), by severity.',
      ['severity'],
    );
    const openStatuses = Prisma.join(
      RISK_ALERT_OPEN_STATUSES.map((s) => Prisma.sql`${s}::"RiskAlertStatus"`),
    );
    return {
      name: 'review_queue',
      gauges: [open, breached, overdue],
      pending: null,
      run: async (db, now) => {
        const rows = await db.$queryRaw<
          Array<{ severity: string; open: number; breached: number; overdue: number }>
        >`
          SELECT severity::text AS severity,
                 COUNT(*)::int AS open,
                 COUNT(*) FILTER (WHERE "slaBreachedAt" IS NOT NULL)::int AS breached,
                 COUNT(*) FILTER (WHERE "dueAt" IS NOT NULL AND "dueAt" < ${now})::int AS overdue
          FROM "RiskAlert"
          WHERE status IN (${openStatuses})
          GROUP BY severity`;
        return () => {
          for (const severity of Object.values(RiskSeverity)) {
            const row = rows.find((r) => r.severity === severity);
            open.set({ severity }, row?.open ?? 0);
            breached.set({ severity }, row?.breached ?? 0);
            overdue.set({ severity }, row?.overdue ?? 0);
          }
        };
      },
    };
  }

  private linkRequestCollector(): Collector {
    const pending = this.gauge(
      'dfn_counterparty_link_requests_pending',
      'Counterparty link requests waiting for the target organisation to accept or decline.',
    );
    return {
      name: 'link_requests',
      gauges: [pending],
      pending: null,
      run: async (db) => {
        const count = await db.counterparty.count({ where: { linkStatus: 'PENDING' } });
        return () => pending.set(count);
      },
    };
  }

  private transferCollector(): Collector {
    const byStatus = this.gauge(
      'dfn_transfers',
      'Transfer rows by status (REVIEW_REQUIRED = awaiting a compliance decision).',
      ['status'],
    );
    return {
      name: 'transfers',
      gauges: [byStatus],
      pending: null,
      run: async (db) => {
        const counts = await db.transfer.groupBy({ by: ['status'], _count: { _all: true } });
        return () => {
          for (const status of Object.values(TransferStatus)) {
            byStatus.set({ status }, counts.find((c) => c.status === status)?._count._all ?? 0);
          }
        };
      },
    };
  }

  private documentCollector(): Collector {
    const byScan = this.gauge(
      'dfn_documents',
      'Document rows by antivirus verdict (scanStatus); INFECTED must stay at 0.',
      ['scan_status'],
    );
    return {
      name: 'documents',
      gauges: [byScan],
      pending: null,
      run: async (db) => {
        const counts = await db.document.groupBy({ by: ['scanStatus'], _count: { _all: true } });
        return () => {
          for (const scanStatus of Object.values(DocumentScanStatus)) {
            byScan.set(
              { scan_status: scanStatus },
              counts.find((c) => c.scanStatus === scanStatus)?._count._all ?? 0,
            );
          }
        };
      },
    };
  }

  private encryptionKeyCollector(): Collector {
    const byStatus = this.gauge(
      'dfn_encryption_keys',
      'KMS-managed data keys by purpose and lifecycle status (none with KMS_PROVIDER=none).',
      ['purpose', 'status'],
    );
    return {
      name: 'encryption_keys',
      gauges: [byStatus],
      pending: null,
      run: async (db) => {
        const counts = await db.encryptionKey.groupBy({
          by: ['purpose', 'status'],
          _count: { _all: true },
        });
        return () => {
          const purposes = new Set<string>([...Object.values(KeyPurpose), ...counts.map((c) => c.purpose)]);
          for (const purpose of purposes) {
            for (const status of Object.values(EncryptionKeyStatus)) {
              byStatus.set(
                { purpose, status },
                counts.find((c) => c.purpose === purpose && c.status === status)?._count._all ?? 0,
              );
            }
          }
        };
      },
    };
  }

  private reconciliationCollector(): Collector {
    const lastStatus = this.gauge(
      'dfn_ledger_reconciliation_last_run_status',
      'Status of the latest ledger ReconciliationJob: 1 for its status, 0 for the others (all 0 until a first run).',
      ['status'],
    );
    const lastAge = this.gauge(
      'dfn_ledger_reconciliation_last_run_age_seconds',
      'Seconds since the latest reconciliation started (absent until a first run).',
    );
    const lastDuration = this.gauge(
      'dfn_ledger_reconciliation_last_run_duration_seconds',
      'Duration of the latest reconciliation (elapsed so far when RUNNING).',
    );
    const differences = this.gauge(
      'dfn_ledger_reconciliation_last_completed_differences',
      'Differences found by the latest COMPLETED reconciliation; anything above 0 is an incident.',
    );
    const accountsChecked = this.gauge(
      'dfn_ledger_reconciliation_last_completed_accounts_checked',
      'Accounts checked by the latest COMPLETED reconciliation.',
    );
    return {
      name: 'ledger_reconciliation',
      gauges: [lastStatus, lastAge, lastDuration, differences, accountsChecked],
      pending: null,
      run: async (db, now) => {
        const last = await db.reconciliationJob.findFirst({
          orderBy: { startedAt: 'desc' },
          select: { status: true, startedAt: true, finishedAt: true },
        });
        const lastCompleted = await db.reconciliationJob.findFirst({
          where: { status: 'COMPLETED' },
          orderBy: { startedAt: 'desc' },
          select: { differencesFound: true, accountsChecked: true },
        });
        return () => {
          // The status series exist even before the first run (all 0): an alert can tell "never
          // ran" from "collector failed" (no series at all).
          for (const status of Object.values(ReconciliationStatus)) {
            lastStatus.set({ status }, last?.status === status ? 1 : 0);
          }
          if (last) {
            lastAge.set(seconds(last.startedAt, now));
            lastDuration.set(seconds(last.startedAt, last.finishedAt ?? now));
          }
          if (lastCompleted) {
            differences.set(lastCompleted.differencesFound);
            accountsChecked.set(lastCompleted.accountsChecked);
          }
        };
      },
    };
  }
}
