/**
 * Restore drill — ledger reconciliation against a (restored) database.
 *
 * SANDBOX ONLY: every amount is a fictitious minor-unit amount. This script never posts, edits or
 * deletes ledger entries; `LedgerService.reconcile()` only reads the ledger and records one
 * `ReconciliationJob` row (plus its differences) in the target database, which is why it is meant
 * to run against a scratch database restored from a backup (see infra/ops/restore-test.sh).
 *
 * Assertions (exit code 1 when any of them fails):
 *   - 0 unbalanced ledger transactions (sum of debits == sum of credits per transaction)
 *   - global debits == global credits for every currency
 *   - 0 reconciliation differences (snapshot continuity, forbidden negative balances),
 *     unless --allow-differences is passed
 *
 * Usage:
 *   compiled:  RECONCILE_DATABASE_URL=postgresql://… node apps/api/dist/reconcile-ledger.js [--json]
 *   source:    cd apps/api && RECONCILE_DATABASE_URL=… node -r ts-node/register/transpile-only \
 *                -r tsconfig-paths/register ../../infra/ops/reconcile-ledger.ts
 * RECONCILE_DATABASE_URL falls back to DATABASE_URL. Exit codes: 0 ok, 1 assertion failed, 2 error.
 */
import { createPrismaClient } from '@dfn/database';
import { LedgerService } from '@dfn/financial-ledger';

interface CurrencyTotals {
  currency: string;
  debitsMinor: string;
  creditsMinor: string;
  balanced: boolean;
}

interface DrillReport {
  ok: boolean;
  jobId: string;
  accountsChecked: number;
  ledgerTransactions: number;
  ledgerEntries: number;
  unbalancedTransactions: string[];
  differences: Array<{ accountId: string; expectedMinor: string; actualMinor: string; note: string }>;
  currencies: CurrencyTotals[];
  failures: string[];
}

function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has('--json');
  const allowDifferences = args.has('--allow-differences');
  const url = process.env.RECONCILE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('[reconcile-ledger] RECONCILE_DATABASE_URL (or DATABASE_URL) is required');
    return 2;
  }

  const prisma = createPrismaClient({ url, log: ['error'] });
  try {
    const [ledgerTransactions, ledgerEntries] = await Promise.all([
      prisma.ledgerTransaction.count(),
      prisma.ledgerEntry.count(),
    ]);
    const result = await new LedgerService(prisma).reconcile();

    const codes = new Set([
      ...Object.keys(result.globalDebitsMinor),
      ...Object.keys(result.globalCreditsMinor),
    ]);
    const currencies: CurrencyTotals[] = [...codes].sort().map((currency) => {
      const debits = result.globalDebitsMinor[currency] ?? 0n;
      const credits = result.globalCreditsMinor[currency] ?? 0n;
      return {
        currency,
        debitsMinor: debits.toString(),
        creditsMinor: credits.toString(),
        balanced: debits === credits,
      };
    });

    const failures: string[] = [];
    if (result.unbalancedTransactions.length > 0) {
      failures.push(`${result.unbalancedTransactions.length} unbalanced ledger transaction(s)`);
    }
    for (const c of currencies) {
      if (!c.balanced) failures.push(`global debits != credits for ${c.currency}`);
    }
    if (result.differences.length > 0 && !allowDifferences) {
      failures.push(`${result.differences.length} reconciliation difference(s)`);
    }

    const report: DrillReport = {
      ok: failures.length === 0,
      jobId: result.jobId,
      accountsChecked: result.accountsChecked,
      ledgerTransactions,
      ledgerEntries,
      unbalancedTransactions: result.unbalancedTransactions,
      differences: result.differences.map((d) => ({
        accountId: d.accountId,
        expectedMinor: d.expectedMinor.toString(),
        actualMinor: d.actualMinor.toString(),
        note: d.note,
      })),
      currencies,
      failures,
    };

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[reconcile-ledger] database: ${redact(url)}`);
      console.log(
        `[reconcile-ledger] accounts=${report.accountsChecked} transactions=${ledgerTransactions} entries=${ledgerEntries} job=${report.jobId}`,
      );
      for (const c of currencies) {
        console.log(
          `[reconcile-ledger]   ${c.currency}: debits=${c.debitsMinor} credits=${c.creditsMinor} ${c.balanced ? 'OK' : 'MISMATCH'} (fictitious minor units)`,
        );
      }
      for (const d of report.differences) {
        console.log(
          `[reconcile-ledger]   difference: ${d.note} (expected ${d.expectedMinor}, actual ${d.actualMinor})`,
        );
      }
      for (const id of report.unbalancedTransactions) {
        console.log(`[reconcile-ledger]   unbalanced transaction: ${id}`);
      }
      console.log(
        report.ok
          ? '[reconcile-ledger] OK — ledger balanced'
          : `[reconcile-ledger] FAILED — ${failures.join('; ')}`,
      );
    }
    return report.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('[reconcile-ledger] error:', err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
