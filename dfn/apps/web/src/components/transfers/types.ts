import type { MoneyDto } from '@/lib/format';

/** Wire shapes of the transfers API as consumed by the web app. */
export interface FxQuoteDto {
  id: string;
  organizationId: string;
  originCountry: string | null;
  destinationCountry: string | null;
  status: 'QUOTED' | 'USED' | 'EXPIRED';
  source: MoneyDto;
  fee: MoneyDto & { feeBps: number; fixedFee: MoneyDto | null };
  totalDebit: MoneyDto;
  destination: MoneyDto;
  rate: { numerator: string; denominator: string; display: string };
  spreadBps: number | null;
  provider: string;
  simulated: true;
  expiresAt: string;
  createdAt: string;
}

export interface BeneficiarySnapshot {
  id?: string;
  name: string;
  country: string;
  currencyCode: string;
  method: 'BANK_ACCOUNT' | 'MOBILE_MONEY';
  accountIdentifierMasked: string;
  institutionName: string | null;
}

export interface BeneficiaryDto extends BeneficiarySnapshot {
  id: string;
  organizationId: string;
  status: 'ACTIVE' | 'REMOVED';
  createdAt: string;
}

export interface TransferEventDto {
  id: string;
  type: string;
  actorUserId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface TransferSummaryDto {
  id: string;
  reference: string;
  organizationId: string;
  organization?: { id: string; name: string; type: string };
  status: string;
  purpose: string | null;
  originCountry: string;
  destinationCountry: string;
  sourceCurrency: string;
  destinationCurrency: string;
  source: MoneyDto;
  fee: MoneyDto;
  totalDebit: MoneyDto;
  destination: MoneyDto;
  beneficiaryName: string | null;
  riskScore: number | null;
  quoteExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  simulated: true;
}

export interface TransferDto extends TransferSummaryDto {
  createdBy?: { id: string; firstName: string; lastName: string; email?: string };
  rate: { numerator: string; denominator: string; display: string };
  spreadBps: number | null;
  feeBps: number | null;
  provider: string | null;
  quoteId: string | null;
  beneficiaryId: string | null;
  beneficiary: BeneficiarySnapshot;
  clientReference: string | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  failureReason: string | null;
  cancelReason: string | null;
  externalRef: string | null;
  ledger: {
    sourceLedgerTransactionId: string | null;
    destinationLedgerTransactionId: string | null;
    reversalLedgerTransactionId: string | null;
  };
  quotedAt: string | null;
  authorizedAt: string | null;
  processingAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  events: TransferEventDto[];
  myRole: string | null;
  nextActions: string[];
  disclaimer: string;
}

export interface AdminTransferRow extends TransferSummaryDto {
  createdBy: { id: string; email: string; name: string } | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  failureReason: string | null;
  authorizedAt: string | null;
  processingAt: string | null;
}

export const TRANSFER_STATUSES = [
  'QUOTED',
  'REVIEW_REQUIRED',
  'PROCESSING',
  'SETTLED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;

export const TRANSFER_PURPOSES = [
  'FAMILY_SUPPORT',
  'GOODS',
  'SERVICES',
  'EDUCATION',
  'HEALTH',
  'BUSINESS',
  'OTHER',
] as const;
