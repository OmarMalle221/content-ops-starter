export class LedgerError extends Error {
  constructor(
    public readonly code:
      | 'LEDGER_UNBALANCED'
      | 'INSUFFICIENT_FUNDS'
      | 'ACCOUNT_NOT_FOUND'
      | 'ACCOUNT_FROZEN'
      | 'CURRENCY_MISMATCH'
      | 'INVALID_AMOUNT'
      | 'INVALID_POSTING'
      | 'ALREADY_REVERSED',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
