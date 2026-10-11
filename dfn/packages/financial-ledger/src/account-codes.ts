/**
 * Stable ledger account codes. The chart of accounts of the sandbox:
 *
 *  ASSET      PROVIDER_SETTLEMENT:<provider>:<ccy>  — simulated funds held at the licensed partner
 *  LIABILITY  ESCROW:<transactionId>:<ccy>          — funds held for a Protect transaction
 *  LIABILITY  WALLET:<organizationId>:<ccy>         — simulated wallet balance owed to an organisation
 *  REVENUE    PLATFORM_FEES:<ccy>                   — platform commission
 *  LIABILITY  REFUND_PAYABLE:<ccy>                  — refunds returned to the partner for payout (future)
 */
export const providerSettlementCode = (providerCode: string, ccy: string) =>
  `PROVIDER_SETTLEMENT:${providerCode.toUpperCase()}:${ccy}`;
export const escrowAccountCode = (transactionId: string, ccy: string) => `ESCROW:${transactionId}:${ccy}`;
export const walletAccountCode = (organizationId: string, ccy: string) => `WALLET:${organizationId}:${ccy}`;
export const platformFeesCode = (ccy: string) => `PLATFORM_FEES:${ccy}`;

/**
 * Phase 4–5 accounts.
 *  EQUITY/clearing  FX_CLEARING:<ccy>              — one leg per currency of a simulated FX conversion (allowNegative)
 *  LIABILITY        TRANSFER_PAYOUT:<transferId>:<ccy> — destination funds awaiting simulated payout
 *  ASSET (contra)   DDA_ISSUANCE:DDA               — fictitious units issued (supply = -balance), allowNegative
 *  LIABILITY        DDA_HOLDING:<organizationId>:DDA — fictitious units held by an organisation
 *  ASSET            DDA_RESERVE_SIM:USD            — simulated reserve backing the fictitious units
 */
export const fxClearingCode = (ccy: string) => `FX_CLEARING:${ccy}`;
export const transferPayoutCode = (transferId: string, ccy: string) => `TRANSFER_PAYOUT:${transferId}:${ccy}`;
export const ddaIssuanceCode = () => `DDA_ISSUANCE:DDA`;
export const ddaHoldingCode = (organizationId: string) => `DDA_HOLDING:${organizationId}:DDA`;
export const ddaReserveCode = () => `DDA_RESERVE_SIM:USD`;
