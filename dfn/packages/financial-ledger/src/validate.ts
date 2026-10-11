import { LedgerError } from './errors';
import type { EntryInstruction } from './types';

/**
 * Pure validation of a posting before it touches the database:
 *  - at least two entries
 *  - every amount is a positive integer
 *  - exactly one currency per posting (FX is modelled as two linked postings through a clearing account)
 *  - debits equal credits
 */
export function validateEntries(entries: EntryInstruction[]): void {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new LedgerError('INVALID_POSTING', 'A posting needs at least two entries');
  }
  const currencies = new Set(entries.map((e) => e.currencyCode));
  if (currencies.size !== 1) {
    throw new LedgerError('CURRENCY_MISMATCH', 'All entries of a posting must share one currency', [
      ...currencies,
    ]);
  }
  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (typeof entry.amountMinor !== 'bigint' || entry.amountMinor <= 0n) {
      throw new LedgerError('INVALID_AMOUNT', 'Entry amounts must be positive integers (minor units)', entry);
    }
    if (!entry.accountId && !entry.accountCode) {
      throw new LedgerError('INVALID_POSTING', 'Entry must reference an account id or code', entry);
    }
    if (entry.direction === 'DEBIT') debits += entry.amountMinor;
    else if (entry.direction === 'CREDIT') credits += entry.amountMinor;
    else throw new LedgerError('INVALID_POSTING', `Unknown direction ${String(entry.direction)}`);
  }
  if (debits !== credits) {
    throw new LedgerError('LEDGER_UNBALANCED', `Debits (${debits}) do not equal credits (${credits})`, {
      debits: debits.toString(),
      credits: credits.toString(),
    });
  }
}

/** Signed balance for an account given its normal side. */
export function computeBalance(normalBalance: 'DEBIT' | 'CREDIT', debits: bigint, credits: bigint): bigint {
  return normalBalance === 'DEBIT' ? debits - credits : credits - debits;
}
