import type { BalanceSide, LedgerAccountType, LedgerOwnerType, LedgerTransactionKind } from '@dfn/database';

export interface EntryInstruction {
  /** Either an account id or a stable account code. */
  accountId?: string;
  accountCode?: string;
  direction: BalanceSide;
  amountMinor: bigint;
  currencyCode: string;
}

export interface PostingInstruction {
  /** Caller-provided idempotency key — the same key always yields the same ledger transaction. */
  idempotencyKey: string;
  kind: LedgerTransactionKind;
  description: string;
  reference?: string;
  metadata?: Record<string, unknown>;
  entries: EntryInstruction[];
}

export interface PostedTransaction {
  id: string;
  idempotencyKey: string;
  kind: LedgerTransactionKind;
  postedAt: Date;
  /** True when the idempotency key had already been used; no new entries were written. */
  replayed: boolean;
  entries: Array<{
    id: string;
    accountId: string;
    direction: BalanceSide;
    amountMinor: bigint;
    currencyCode: string;
  }>;
}

export interface EnsureAccountInput {
  code: string;
  name: string;
  type: LedgerAccountType;
  normalBalance: BalanceSide;
  currencyCode: string;
  ownerType: LedgerOwnerType;
  ownerId?: string | null;
  allowNegative?: boolean;
}

export interface AccountBalance {
  accountId: string;
  code: string;
  currencyCode: string;
  normalBalance: BalanceSide;
  balanceMinor: bigint;
  debitsMinor: bigint;
  creditsMinor: bigint;
  entryCount: number;
}

export interface ReconciliationResult {
  jobId: string;
  accountsChecked: number;
  differences: Array<{ accountId: string; expectedMinor: bigint; actualMinor: bigint; note: string }>;
  unbalancedTransactions: string[];
  globalDebitsMinor: Record<string, bigint>;
  globalCreditsMinor: Record<string, bigint>;
}
