/**
 * Bulk dataset for the load test — SANDBOX ONLY (fictitious data, no real funds).
 *
 * PRODUCT_REQUIREMENTS.md §5 sets the list target "< 500 ms p95 on 100 000 transactions". This
 * script gives one user's organisation that volume, directly in PostgreSQL (the API would need
 * hours), so that `test/load/run.ts` measures GET /v1/transactions under the stated condition.
 *
 * Rows are Protect transactions that never involved money (DRAFT, PENDING_ACCEPTANCE, CANCELLED,
 * EXPIRED), referenced `LOAD-<tag>-<n>` and tagged `metadata.loadTest = true`: no ledger entry is
 * written and no ledger history is touched. `--cleanup` deletes exactly those rows.
 *
 *   DATABASE_URL=… node -r ts-node/register/transpile-only -r tsconfig-paths/register \
 *     test/load/bulk-transactions.ts --email moussa@demo.dfn --count 100000
 *   … test/load/bulk-transactions.ts --email moussa@demo.dfn --cleanup
 *
 * Safety: refuses to run unless the database name contains "test" or "load", or LOAD_BULK_FORCE=1.
 */
import { createPrismaClient } from '@dfn/database';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BATCH = 10_000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test|load/i.test(dbName) && process.env.LOAD_BULK_FORCE !== '1') {
    throw new Error(`Refusing to write a load dataset into "${dbName}" (expected a test/load database)`);
  }
  const email = arg('email') ?? 'moussa@demo.dfn';
  const cleanup = process.argv.includes('--cleanup');
  const count = Number(arg('count') ?? '100000');
  if (!cleanup && (!Number.isInteger(count) || count < 1 || count > 1_000_000)) {
    throw new Error('--count must be an integer between 1 and 1 000 000');
  }

  const prisma = createPrismaClient({ url });
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { where: { role: 'OWNER' }, include: { organization: true } } },
    });
    const org = user?.memberships.find((m) => m.organization.type === 'PERSONAL')?.organization;
    if (!user || !org) throw new Error(`${email} has no personal organisation`);

    if (cleanup) {
      const deleted = await prisma.$executeRaw`
        DELETE FROM "Transaction"
        WHERE "buyerOrganizationId" = ${org.id}::uuid
          AND reference LIKE 'LOAD-%'
          AND metadata->>'loadTest' = 'true'`;
      console.log(`Deleted ${deleted} load-test transaction(s) of ${email}.`);
      return;
    }

    const tag = Date.now().toString(36).toUpperCase();
    const started = Date.now();
    for (let from = 1; from <= count; from += BATCH) {
      const to = Math.min(count, from + BATCH - 1);
      await prisma.$executeRaw`
        INSERT INTO "Transaction" (
          id, reference, "createdByUserId", "buyerOrganizationId", title, description, category,
          "currencyCode", "amountMinor", "feeMinor", "feeBps", status, "originCountry",
          "destinationCountry", metadata, "createdAt", "updatedAt")
        SELECT
          gen_random_uuid(),
          'LOAD-' || ${tag} || '-' || lpad(g::text, 7, '0'),
          ${user.id}::uuid,
          ${org.id}::uuid,
          'Transaction de charge #' || g || ' (fictive)',
          'Données fictives — Aucun fonds réel (jeu de données du test de charge).',
          'GOODS',
          'CAD',
          100000 + (g % 900) * 1000,
          (100000 + (g % 900) * 1000) * 150 / 10000,
          150,
          (ARRAY['DRAFT','PENDING_ACCEPTANCE','CANCELLED','EXPIRED'])[1 + g % 4]::"TransactionStatus",
          'CA',
          'SN',
          '{"loadTest": true, "simulated": true}'::jsonb,
          now() - make_interval(secs => g),
          now() - make_interval(secs => g)
        FROM generate_series(${from}::int, ${to}::int) AS g`;
      process.stdout.write(`\r  inserted ${to}/${count}`);
    }
    await prisma.$executeRawUnsafe('ANALYZE "Transaction"');
    console.log(`\nInserted ${count} load-test transactions for ${email} in ${Date.now() - started} ms.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
