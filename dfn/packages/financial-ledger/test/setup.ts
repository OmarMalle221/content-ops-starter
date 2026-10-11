import { createPrismaClient, type PrismaClient } from '@dfn/database';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:54329/dfn_test?schema=public';

let client: PrismaClient | undefined;
export function prisma(): PrismaClient {
  if (!client) client = createPrismaClient({ url: TEST_DATABASE_URL, log: [] });
  return client;
}

export async function resetLedgerTables() {
  const db = prisma();
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ReconciliationDifference","ReconciliationJob","BalanceSnapshot","LedgerEntry","LedgerTransaction","Wallet","LedgerAccount" CASCADE',
  );
  await db.currency.upsert({
    where: { code: 'CAD' },
    update: {},
    create: { code: 'CAD', name: 'Canadian dollar', exponent: 2, symbol: 'CA$' },
  });
  await db.currency.upsert({
    where: { code: 'XOF' },
    update: {},
    create: { code: 'XOF', name: 'Franc CFA', exponent: 0, symbol: 'FCFA' },
  });
}
