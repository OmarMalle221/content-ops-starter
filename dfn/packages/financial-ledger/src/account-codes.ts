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
