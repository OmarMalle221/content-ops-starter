import type { MoneyDto } from '@/lib/format';

/** Wire types of the admin DDA lab (GET /v1/admin/dda/*). Every payload is a research simulation. */

export interface DdaEnvelope {
  simulated: true;
  disclaimer: string;
  disclaimerEn: string;
  hypothesis: string;
}

export interface DdaOrganizationRef {
  id: string;
  name: string;
  type: 'PERSONAL' | 'BUSINESS' | null;
  country?: string | null;
  deleted?: boolean;
}

export interface DdaUserRef {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export type DdaOperationKind = 'MINT' | 'TRANSFER' | 'REDEEM' | 'RESERVE_ADJUSTMENT';

export interface DdaOperation {
  id: string;
  reference: string;
  operation: DdaOperationKind;
  status: string;
  scope: 'PLATFORM' | 'ORGANIZATION';
  units: MoneyDto;
  reserveDeltaUsd: MoneyDto;
  organization: DdaOrganizationRef | null;
  counterparty: DdaOrganizationRef | null;
  createdBy: DdaUserRef | null;
  ledgerTransactionId: string | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  simulated: true;
}

export interface DdaHolding {
  accountId: string;
  accountCode: string;
  organization: DdaOrganizationRef;
  balance: MoneyDto;
  shareBps: number;
  entryCount: number;
}

export interface DdaOverview extends DdaEnvelope {
  currency: { code: string; name: string; exponent: number; kind: string };
  supply: MoneyDto;
  sumHoldings: MoneyDto;
  invariantHolds: boolean;
  reserveUsd: MoneyDto;
  coverageRatioBps: number | null;
  holdersCount: number;
  topHoldings: DdaHolding[];
  operationsCount: number;
  lastOperations: DdaOperation[];
  redLines: string[];
}

export interface DdaHoldingsResponse extends DdaEnvelope {
  supply: MoneyDto;
  sumHoldings: MoneyDto;
  invariantHolds: boolean;
  items: DdaHolding[];
  total: number;
}

export interface DdaOperationsResponse extends DdaEnvelope {
  items: DdaOperation[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DdaOrganizationsResponse extends DdaEnvelope {
  items: Array<{ id: string; name: string; type: 'PERSONAL' | 'BUSINESS'; country: string }>;
  total: number;
}

export interface DdaStressResult extends DdaEnvelope {
  inputs: {
    redemptionPercent: number;
    reserveHaircutPercent: number;
    redemptionBps: number;
    reserveHaircutBps: number;
  };
  supply: MoneyDto;
  reserveUsd: MoneyDto;
  coverageBeforeBps: number | null;
  redeemedUnits: MoneyDto;
  remainingSupply: MoneyDto;
  reserveAfterHaircut: MoneyDto;
  reserveAfterRedemptions: MoneyDto;
  shortfallUsd: MoneyDto;
  coverageAfterBps: number | null;
  verdict: 'COVERED' | 'SHORTFALL';
  notes: string[];
}

export interface DdaTraceResponse extends DdaEnvelope {
  operation: DdaOperation;
  ledgerTransaction: {
    id: string;
    idempotencyKey: string;
    kind: string;
    status: string;
    description: string;
    reference: string | null;
    metadata: Record<string, unknown> | null;
    postedAt: string;
    entries: Array<{
      id: string;
      direction: 'DEBIT' | 'CREDIT';
      amount: MoneyDto;
      account: {
        id: string;
        code: string;
        name: string;
        type: string;
        normalBalance: string;
        currencyCode: string;
        ownerType: string;
        ownerId: string | null;
      };
      createdAt: string;
    }>;
  } | null;
  audit: Array<{
    id: string;
    action: string;
    actor: DdaUserRef | null;
    organizationId: string | null;
    metadata: Record<string, unknown> | null;
    ip: string | null;
    createdAt: string;
  }>;
}

/**
 * Deterministic basis-points → percent rendering (no Intl): 8000 → "80,00 %" (fr) / "80.00%" (en).
 * `null` means nothing is in circulation (division by zero avoided server-side).
 */
export function formatBps(bps: number | null | undefined, locale: 'fr' | 'en' = 'fr'): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  const fixed = (bps / 100).toFixed(2);
  return locale === 'fr' ? `${fixed.replace('.', ',')} %` : `${fixed}%`;
}

export const DDA_DOCS = {
  architecture: 'docs/architecture/DDA_SIMULATION.md',
  compliance: 'docs/compliance/STABLECOIN_RISKS.md',
} as const;
