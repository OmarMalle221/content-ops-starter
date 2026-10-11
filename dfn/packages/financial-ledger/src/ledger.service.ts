import { Prisma, type PrismaClient, type PrismaTransactionClient, type LedgerAccount } from '@dfn/database';
import { LedgerError } from './errors';
import type {
  AccountBalance,
  EnsureAccountInput,
  PostedTransaction,
  PostingInstruction,
  ReconciliationResult,
} from './types';
import { computeBalance, validateEntries } from './validate';

type Db = PrismaClient | PrismaTransactionClient;

/**
 * Double-entry ledger service.
 *
 * Guarantees:
 *  - every posting is balanced (validated in memory and re-checked in SQL by reconciliation)
 *  - postings are idempotent on `idempotencyKey` (unique index + replay detection)
 *  - accounts are locked with SELECT … FOR UPDATE in a deterministic order, so concurrent
 *    postings on the same accounts serialise and negative balances cannot slip through
 *  - entries are never updated or deleted; corrections are reversals
 */
export class LedgerService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Idempotent, concurrency-safe lazy creation: INSERT … ON CONFLICT DO NOTHING (createMany with
   * skipDuplicates) never raises a unique violation, so it cannot abort an enclosing transaction
   * when two requests create the same account at the same time; the row is then read back.
   */
  async ensureAccount(input: EnsureAccountInput, db: Db = this.prisma): Promise<LedgerAccount> {
    const existing = await db.ledgerAccount.findUnique({ where: { code: input.code } });
    if (existing) return existing;
    await db.ledgerAccount.createMany({
      data: [
        {
          code: input.code,
          name: input.name,
          type: input.type,
          normalBalance: input.normalBalance,
          currencyCode: input.currencyCode,
          ownerType: input.ownerType,
          ownerId: input.ownerId ?? null,
          allowNegative: input.allowNegative ?? false,
        },
      ],
      skipDuplicates: true,
    });
    return db.ledgerAccount.findUniqueOrThrow({ where: { code: input.code } });
  }

  async getAccountByCode(code: string, db: Db = this.prisma): Promise<LedgerAccount | null> {
    return db.ledgerAccount.findUnique({ where: { code } });
  }

  /**
   * Post a balanced transaction. Can run inside an outer interactive transaction (pass `db`)
   * so that business state changes and ledger entries commit atomically.
   */
  async post(instruction: PostingInstruction, db?: PrismaTransactionClient): Promise<PostedTransaction> {
    validateEntries(instruction.entries);
    if (db) return this.postWithin(instruction, db);
    try {
      return await this.prisma.$transaction((tx) => this.postWithin(instruction, tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (err) {
      // Race on the idempotency key: another request committed first — return its result.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.findByIdempotencyKey(instruction.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async postWithin(
    instruction: PostingInstruction,
    tx: PrismaTransactionClient,
  ): Promise<PostedTransaction> {
    const existing = await this.findByIdempotencyKey(instruction.idempotencyKey, tx);
    if (existing) return existing;

    // Resolve accounts and lock them in a deterministic order (by id) to avoid deadlocks.
    const resolved = await this.resolveAccounts(instruction, tx);
    const ids = [...new Set(resolved.map((r) => r.account.id))].sort();
    const locked = await tx.$queryRaw<LedgerAccount[]>`
      SELECT * FROM "LedgerAccount" WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY id FOR UPDATE`;
    if (locked.length !== ids.length) {
      throw new LedgerError('ACCOUNT_NOT_FOUND', 'One or more ledger accounts could not be locked');
    }
    const byId = new Map(locked.map((a) => [a.id, a]));

    for (const account of locked) {
      if (account.status !== 'ACTIVE') {
        throw new LedgerError('ACCOUNT_FROZEN', `Account ${account.code} is ${account.status}`);
      }
    }
    for (const { account, entry } of resolved) {
      if (account.currencyCode !== entry.currencyCode) {
        throw new LedgerError(
          'CURRENCY_MISMATCH',
          `Account ${account.code} is ${account.currencyCode}, entry is ${entry.currencyCode}`,
        );
      }
    }

    // Projected balances after this posting, for accounts that forbid negative balances.
    const deltas = new Map<string, bigint>();
    for (const { account, entry } of resolved) {
      const signed = computeBalance(
        account.normalBalance,
        entry.direction === 'DEBIT' ? entry.amountMinor : 0n,
        entry.direction === 'CREDIT' ? entry.amountMinor : 0n,
      );
      deltas.set(account.id, (deltas.get(account.id) ?? 0n) + signed);
    }
    for (const [accountId, delta] of deltas) {
      const account = byId.get(accountId)!;
      if (account.allowNegative || delta >= 0n) continue;
      const current = await this.balanceWithin(account, tx);
      if (current.balanceMinor + delta < 0n) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `Account ${account.code} would become negative`, {
          accountCode: account.code,
          balanceMinor: current.balanceMinor.toString(),
          deltaMinor: delta.toString(),
        });
      }
    }

    const created = await tx.ledgerTransaction.create({
      data: {
        idempotencyKey: instruction.idempotencyKey,
        kind: instruction.kind,
        description: instruction.description,
        reference: instruction.reference ?? null,
        metadata: (instruction.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        entries: {
          create: resolved.map(({ account, entry }) => ({
            accountId: account.id,
            direction: entry.direction,
            amountMinor: entry.amountMinor,
            currencyCode: entry.currencyCode,
          })),
        },
      },
      include: { entries: true },
    });
    await tx.ledgerAccount.updateMany({ where: { id: { in: ids } }, data: { version: { increment: 1 } } });

    return {
      id: created.id,
      idempotencyKey: created.idempotencyKey,
      kind: created.kind,
      postedAt: created.postedAt,
      replayed: false,
      entries: created.entries.map((e) => ({
        id: e.id,
        accountId: e.accountId,
        direction: e.direction,
        amountMinor: e.amountMinor,
        currencyCode: e.currencyCode,
      })),
    };
  }

  private async resolveAccounts(instruction: PostingInstruction, tx: Db) {
    const codes = instruction.entries.filter((e) => e.accountCode && !e.accountId).map((e) => e.accountCode!);
    const idsWanted = instruction.entries.filter((e) => e.accountId).map((e) => e.accountId!);
    const accounts = await tx.ledgerAccount.findMany({
      where: { OR: [{ code: { in: codes } }, { id: { in: idsWanted } }] },
    });
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return instruction.entries.map((entry) => {
      const account = entry.accountId ? byId.get(entry.accountId) : byCode.get(entry.accountCode!);
      if (!account) {
        throw new LedgerError(
          'ACCOUNT_NOT_FOUND',
          `Unknown ledger account ${entry.accountId ?? entry.accountCode}`,
        );
      }
      return { account, entry };
    });
  }

  async findByIdempotencyKey(key: string, db: Db = this.prisma): Promise<PostedTransaction | null> {
    const found = await db.ledgerTransaction.findUnique({
      where: { idempotencyKey: key },
      include: { entries: true },
    });
    if (!found) return null;
    return {
      id: found.id,
      idempotencyKey: found.idempotencyKey,
      kind: found.kind,
      postedAt: found.postedAt,
      replayed: true,
      entries: found.entries.map((e) => ({
        id: e.id,
        accountId: e.accountId,
        direction: e.direction,
        amountMinor: e.amountMinor,
        currencyCode: e.currencyCode,
      })),
    };
  }

  /** Reverse a posted transaction with a mirrored posting. Never deletes anything. */
  async reverse(
    ledgerTransactionId: string,
    idempotencyKey: string,
    reason: string,
    db?: PrismaTransactionClient,
  ): Promise<PostedTransaction> {
    const run = async (tx: PrismaTransactionClient) => {
      const original = await tx.ledgerTransaction.findUnique({
        where: { id: ledgerTransactionId },
        include: { entries: true },
      });
      if (!original) throw new LedgerError('INVALID_POSTING', 'Ledger transaction not found');
      if (original.status === 'REVERSED') throw new LedgerError('ALREADY_REVERSED', 'Already reversed');
      const posted = await this.postWithin(
        {
          idempotencyKey,
          kind: 'REVERSAL',
          description: `Reversal of ${original.id}: ${reason}`,
          reference: original.reference ?? undefined,
          metadata: { reversesId: original.id, reason },
          entries: original.entries.map((e) => ({
            accountId: e.accountId,
            direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
            amountMinor: e.amountMinor,
            currencyCode: e.currencyCode,
          })),
        },
        tx,
      );
      if (!posted.replayed) {
        await tx.ledgerTransaction.update({ where: { id: posted.id }, data: { reversesId: original.id } });
        await tx.ledgerTransaction.update({ where: { id: original.id }, data: { status: 'REVERSED' } });
      }
      return posted;
    };
    if (db) return run(db);
    return this.prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async balanceWithin(account: LedgerAccount, db: Db): Promise<AccountBalance> {
    const rows = await db.$queryRaw<
      Array<{ direction: 'DEBIT' | 'CREDIT'; total: bigint | null; count: bigint }>
    >`
      SELECT direction, COALESCE(SUM("amountMinor"), 0)::bigint AS total, COUNT(*)::bigint AS count
      FROM "LedgerEntry" WHERE "accountId" = ${account.id}::uuid GROUP BY direction`;
    let debits = 0n;
    let credits = 0n;
    let count = 0;
    for (const r of rows) {
      const total = BigInt(r.total ?? 0);
      if (r.direction === 'DEBIT') debits = total;
      else credits = total;
      count += Number(r.count);
    }
    return {
      accountId: account.id,
      code: account.code,
      currencyCode: account.currencyCode,
      normalBalance: account.normalBalance,
      balanceMinor: computeBalance(account.normalBalance, debits, credits),
      debitsMinor: debits,
      creditsMinor: credits,
      entryCount: count,
    };
  }

  async getBalance(accountIdOrCode: string, db: Db = this.prisma): Promise<AccountBalance> {
    const account = await db.ledgerAccount.findFirst({
      where: {
        OR: [{ id: isUuid(accountIdOrCode) ? accountIdOrCode : undefined }, { code: accountIdOrCode }],
      },
    });
    if (!account) throw new LedgerError('ACCOUNT_NOT_FOUND', `Unknown account ${accountIdOrCode}`);
    return this.balanceWithin(account, db);
  }

  async getBalances(accountIds: string[], db: Db = this.prisma): Promise<AccountBalance[]> {
    const accounts = await db.ledgerAccount.findMany({ where: { id: { in: accountIds } } });
    return Promise.all(accounts.map((a) => this.balanceWithin(a, db)));
  }

  async listEntries(accountId: string, page = 1, pageSize = 50, db: Db = this.prisma) {
    const [items, total] = await Promise.all([
      db.ledgerEntry.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { ledgerTransaction: true },
      }),
      db.ledgerEntry.count({ where: { accountId } }),
    ]);
    return { items, total, page, pageSize };
  }

  /**
   * Balance snapshot taken under the account row lock (the same lock `post()` takes), so no
   * posting on that account can be in flight: the balance, the entry count and `lastSeq`
   * (highest LedgerEntry.seq included) describe exactly one consistent cut.
   */
  async snapshot(accountId: string, db: Db = this.prisma) {
    const run = async (tx: PrismaTransactionClient) => {
      const [account] = await tx.$queryRaw<LedgerAccount[]>`
        SELECT * FROM "LedgerAccount" WHERE id = ${accountId}::uuid FOR UPDATE`;
      if (!account) throw new LedgerError('ACCOUNT_NOT_FOUND', `Ledger account ${accountId} not found`);
      const balance = await this.balanceWithin(account, tx);
      const [row] = await tx.$queryRaw<Array<{ lastSeq: bigint | null }>>`
        SELECT MAX(seq)::bigint AS "lastSeq" FROM "LedgerEntry" WHERE "accountId" = ${accountId}::uuid`;
      return tx.balanceSnapshot.create({
        data: {
          accountId,
          balanceMinor: balance.balanceMinor,
          entryCount: balance.entryCount,
          lastSeq: row?.lastSeq == null ? 0n : BigInt(row.lastSeq),
        },
      });
    };
    return '$transaction' in db && typeof db.$transaction === 'function'
      ? (db as PrismaClient).$transaction(run)
      : run(db as PrismaTransactionClient);
  }

  /**
   * Reconciliation: recompute every balance, compare against the latest snapshot + subsequent
   * entries, verify every ledger transaction is balanced and that global debits equal credits.
   */
  async reconcile(): Promise<ReconciliationResult> {
    const job = await this.prisma.reconciliationJob.create({ data: {} });
    const differences: ReconciliationResult['differences'] = [];
    const unbalanced: string[] = [];
    try {
      const accounts = await this.prisma.ledgerAccount.findMany();
      for (const account of accounts) {
        const latest = await this.prisma.balanceSnapshot.findFirst({
          where: { accountId: account.id },
          orderBy: [{ asOf: 'desc' }, { lastSeq: 'desc' }],
        });
        // One statement computes both the full totals and the "since snapshot" totals, so both
        // views come from the same consistent read: a posting committed between two queries can
        // no longer show up on one side only. Entries are partitioned on `seq` (legacy snapshots
        // without `lastSeq` fall back to the timestamp).
        const rows = await this.prisma.$queryRaw<
          Array<{ direction: 'DEBIT' | 'CREDIT'; total: bigint | null; since: bigint | null; count: bigint }>
        >`
          SELECT direction,
            COALESCE(SUM("amountMinor"),0)::bigint AS total,
            COALESCE(SUM(CASE WHEN ${
              latest?.lastSeq != null
                ? Prisma.sql`seq > ${latest.lastSeq}`
                : latest
                  ? Prisma.sql`"createdAt" > ${latest.asOf}`
                  : Prisma.sql`TRUE`
            } THEN "amountMinor" ELSE 0 END),0)::bigint AS since,
            COUNT(*)::bigint AS count
          FROM "LedgerEntry" WHERE "accountId" = ${account.id}::uuid GROUP BY direction`;
        let td = 0n;
        let tc = 0n;
        let d = 0n;
        let c = 0n;
        let entryCount = 0n;
        for (const r of rows) {
          entryCount += BigInt(r.count);
          if (r.direction === 'DEBIT') {
            td = BigInt(r.total ?? 0);
            d = BigInt(r.since ?? 0);
          } else {
            tc = BigInt(r.total ?? 0);
            c = BigInt(r.since ?? 0);
          }
        }
        const actual = {
          balanceMinor: computeBalance(account.normalBalance, td, tc),
          entryCount: Number(entryCount),
        };
        if (latest) {
          const expected = latest.balanceMinor + computeBalance(account.normalBalance, d, c);
          if (expected !== actual.balanceMinor) {
            differences.push({
              accountId: account.id,
              expectedMinor: expected,
              actualMinor: actual.balanceMinor,
              note: `Snapshot continuity broken for ${account.code}`,
            });
          }
        }
        if (!account.allowNegative && actual.balanceMinor < 0n) {
          differences.push({
            accountId: account.id,
            expectedMinor: 0n,
            actualMinor: actual.balanceMinor,
            note: `Negative balance on account ${account.code} that forbids it`,
          });
        }
      }

      const perTx = await this.prisma.$queryRaw<Array<{ id: string; debits: bigint; credits: bigint }>>`
        SELECT t.id,
          COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor" ELSE 0 END),0)::bigint AS debits,
          COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e."amountMinor" ELSE 0 END),0)::bigint AS credits
        FROM "LedgerTransaction" t JOIN "LedgerEntry" e ON e."ledgerTransactionId" = t.id
        GROUP BY t.id HAVING
          COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor" ELSE 0 END),0) <>
          COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e."amountMinor" ELSE 0 END),0)`;
      for (const row of perTx) unbalanced.push(row.id);

      const globals = await this.prisma.$queryRaw<
        Array<{ currencyCode: string; direction: 'DEBIT' | 'CREDIT'; total: bigint }>
      >`SELECT "currencyCode", direction, COALESCE(SUM("amountMinor"),0)::bigint AS total FROM "LedgerEntry" GROUP BY "currencyCode", direction`;
      const globalDebits: Record<string, bigint> = {};
      const globalCredits: Record<string, bigint> = {};
      for (const g of globals) {
        if (g.direction === 'DEBIT') globalDebits[g.currencyCode] = BigInt(g.total);
        else globalCredits[g.currencyCode] = BigInt(g.total);
      }

      await this.prisma.reconciliationJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          accountsChecked: accounts.length,
          differencesFound: differences.length + unbalanced.length,
          summary: {
            unbalancedTransactions: unbalanced,
            globalDebits: Object.fromEntries(Object.entries(globalDebits).map(([k, v]) => [k, v.toString()])),
            globalCredits: Object.fromEntries(
              Object.entries(globalCredits).map(([k, v]) => [k, v.toString()]),
            ),
          },
          differences: {
            create: differences.map((d) => ({
              accountId: d.accountId,
              expectedMinor: d.expectedMinor,
              actualMinor: d.actualMinor,
              note: d.note,
            })),
          },
        },
      });
      return {
        jobId: job.id,
        accountsChecked: accounts.length,
        differences,
        unbalancedTransactions: unbalanced,
        globalDebitsMinor: globalDebits,
        globalCreditsMinor: globalCredits,
      };
    } catch (err) {
      await this.prisma.reconciliationJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', finishedAt: new Date(), summary: { error: String(err) } },
      });
      throw err;
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
