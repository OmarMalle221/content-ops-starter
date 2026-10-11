import { PrismaClient, Prisma } from '@prisma/client';

export * from '@prisma/client';
export { Prisma };

export type PrismaTransactionClient = Prisma.TransactionClient;

export interface CreatePrismaOptions {
  url?: string;
  log?: Prisma.LogLevel[];
}

/**
 * Factory used by the API, the ledger package and the tests.
 * A single PrismaClient per process is expected; callers manage the lifecycle.
 */
export function createPrismaClient(options: CreatePrismaOptions = {}): PrismaClient {
  return new PrismaClient({
    datasources: options.url ? { db: { url: options.url } } : undefined,
    log: options.log ?? (process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error']),
  });
}
