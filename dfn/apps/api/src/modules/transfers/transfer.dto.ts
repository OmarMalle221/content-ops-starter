import type { FXQuote, PaymentProvider, Transfer, TransferEvent } from '@dfn/database';
import { Permission, TransferEventType, orgRoleHas, type OrgRole } from '@dfn/shared';
import { getCurrency } from '@dfn/shared';
import { moneyDto } from '../../common/serialize';

export const TRANSFER_DISCLAIMER_FR = 'Données fictives — Aucun fonds réel';
/** What members see in place of the risk-rule explanations (a translation key for the UI). */
export const MEMBER_REVIEW_REASON = 'COMPLIANCE_REVIEW';

/** Who is looking at the transfer: an organisation member (with its role) or staff. */
export interface TransferViewer {
  isStaff: boolean;
  role: OrgRole | null;
}

export type TransferWithRelations = Transfer & {
  events: TransferEvent[];
  quote: FXQuote | null;
  provider: PaymentProvider | null;
  organization?: { id: string; name: string; type: string } | null;
  createdBy?: { id: string; email: string; firstName: string; lastName: string } | null;
};

/** Human readable rate on major units: '1 CAD = 433.40 XOF' (integer arithmetic, 2–6 decimals). */
export function rateDisplay(
  numerator: bigint,
  denominator: bigint,
  sourceCurrency: string,
  destinationCurrency: string,
): string {
  if (denominator === 0n) return `1 ${sourceCurrency} = ? ${destinationCurrency}`;
  const scaled = (numerator * 1_000_000n + denominator / 2n) / denominator;
  const whole = scaled / 1_000_000n;
  let frac = (scaled % 1_000_000n).toString().padStart(6, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `1 ${sourceCurrency} = ${whole}.${frac} ${destinationCurrency}`;
}

/** Amount actions the viewer may perform, derived server-side (the UI never guesses). */
export function transferNextActions(transfer: Transfer, viewer: TransferViewer): string[] {
  const actions: string[] = [];
  const can = (p: Permission) => Boolean(viewer.role && orgRoleHas(viewer.role, p));
  switch (transfer.status) {
    case 'QUOTED':
      if (can(Permission.TRANSFER_AUTHORIZE)) actions.push('AUTHORIZE');
      if (can(Permission.TRANSFER_CREATE)) actions.push('CANCEL');
      break;
    case 'REVIEW_REQUIRED':
      if (viewer.isStaff) actions.push('REVIEW');
      if (can(Permission.TRANSFER_CREATE)) actions.push('CANCEL');
      break;
    case 'PROCESSING':
      if (viewer.isStaff || can(Permission.TRANSFER_CREATE)) {
        actions.push('SIMULATE_PARTNER_SETTLEMENT', 'SIMULATE_PARTNER_FAILURE');
      }
      break;
    case 'SETTLED':
    case 'FAILED':
      actions.push('VIEW_RECEIPT');
      break;
    default:
      break;
  }
  return actions;
}

export function toFxQuoteDto(quote: FXQuote, spreadBps: number | null) {
  const src = quote.sourceCurrency;
  const dst = quote.destinationCurrency;
  return {
    id: quote.id,
    organizationId: quote.organizationId,
    originCountry: quote.originCountry,
    destinationCountry: quote.destinationCountry,
    status: quote.status,
    source: moneyDto(quote.sourceAmountMinor, src),
    fee: {
      ...moneyDto(quote.feeMinor, src)!,
      feeBps: quote.feeBps,
      fixedFee: moneyDto(quote.fixedFeeMinor, src),
    },
    totalDebit: moneyDto(quote.sourceAmountMinor + quote.feeMinor, src),
    destination: moneyDto(quote.destinationAmountMinor, dst),
    rate: {
      numerator: quote.rateNumerator.toString(),
      denominator: quote.rateDenominator.toString(),
      display: rateDisplay(quote.rateNumerator, quote.rateDenominator, src, dst),
    },
    exponents: { source: getCurrency(src).exponent, destination: getCurrency(dst).exponent },
    spreadBps,
    provider: quote.provider,
    simulated: true as const,
    disclaimer: TRANSFER_DISCLAIMER_FR,
    expiresAt: quote.expiresAt,
    createdAt: quote.createdAt,
  };
}

function metadataOf(transfer: Transfer): Record<string, unknown> {
  return transfer.metadata && typeof transfer.metadata === 'object' && !Array.isArray(transfer.metadata)
    ? (transfer.metadata as Record<string, unknown>)
    : {};
}

/**
 * Risk-rule codes and explanations are staff-only: a member learns that a compliance review takes
 * place (the status says as much), never which rule fired or why.
 */
function reviewReasonFor(transfer: Transfer, viewer: TransferViewer): string | null {
  if (!transfer.reviewReason) return null;
  return viewer.isStaff ? transfer.reviewReason : MEMBER_REVIEW_REASON;
}

function eventPayloadFor(event: TransferEvent, viewer: TransferViewer): unknown {
  const payload = event.payload;
  if (viewer.isStaff || event.type !== TransferEventType.REVIEW_REQUIRED) return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const redacted = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'signals' && key !== 'reason'),
  );
  return { ...redacted, reason: MEMBER_REVIEW_REASON };
}

export function toTransferSummary(transfer: TransferWithRelations) {
  const src = transfer.sourceCurrency;
  const dst = transfer.destinationCurrency;
  const beneficiary = (transfer.beneficiary ?? {}) as Record<string, unknown>;
  return {
    id: transfer.id,
    reference: transfer.reference,
    organizationId: transfer.organizationId,
    organization: transfer.organization
      ? { id: transfer.organization.id, name: transfer.organization.name, type: transfer.organization.type }
      : undefined,
    status: transfer.status,
    purpose: transfer.purpose,
    originCountry: transfer.originCountry,
    destinationCountry: transfer.destinationCountry,
    sourceCurrency: src,
    destinationCurrency: dst,
    source: moneyDto(transfer.sourceAmountMinor, src),
    fee: moneyDto(transfer.feeMinor, src),
    totalDebit: moneyDto(transfer.sourceAmountMinor + transfer.feeMinor, src),
    destination: moneyDto(transfer.destinationAmountMinor, dst),
    beneficiaryName: typeof beneficiary.name === 'string' ? beneficiary.name : null,
    riskScore: transfer.riskScore,
    quoteExpiresAt: transfer.quote?.expiresAt ?? null,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
    settledAt: transfer.settledAt,
    simulated: true as const,
  };
}

export function toTransferDto(transfer: TransferWithRelations, viewer: TransferViewer) {
  const src = transfer.sourceCurrency;
  const dst = transfer.destinationCurrency;
  const meta = metadataOf(transfer);
  return {
    ...toTransferSummary(transfer),
    createdBy: transfer.createdBy
      ? {
          id: transfer.createdBy.id,
          firstName: transfer.createdBy.firstName,
          lastName: transfer.createdBy.lastName,
          email: viewer.isStaff ? transfer.createdBy.email : undefined,
        }
      : undefined,
    rate: {
      numerator: transfer.rateNumerator.toString(),
      denominator: transfer.rateDenominator.toString(),
      display: rateDisplay(transfer.rateNumerator, transfer.rateDenominator, src, dst),
    },
    spreadBps: typeof meta.spreadBps === 'number' ? meta.spreadBps : null,
    feeBps: typeof meta.feeBps === 'number' ? meta.feeBps : null,
    provider: transfer.provider?.code ?? null,
    quoteId: transfer.quoteId,
    beneficiaryId: transfer.beneficiaryId,
    beneficiary: transfer.beneficiary,
    clientReference: typeof meta.clientReference === 'string' ? meta.clientReference : null,
    reviewReason: reviewReasonFor(transfer, viewer),
    reviewedAt: transfer.reviewedAt,
    reviewNote: typeof meta.reviewNote === 'string' ? meta.reviewNote : null,
    failureReason: transfer.failureReason,
    cancelReason: typeof meta.cancelReason === 'string' ? meta.cancelReason : null,
    externalRef: transfer.externalRef,
    ledger: {
      sourceLedgerTransactionId: transfer.sourceLedgerTransactionId,
      destinationLedgerTransactionId: transfer.destinationLedgerTransactionId,
      reversalLedgerTransactionId: transfer.reversalLedgerTransactionId,
    },
    quotedAt: transfer.quotedAt,
    authorizedAt: transfer.authorizedAt,
    processingAt: transfer.processingAt,
    failedAt: transfer.failedAt,
    cancelledAt: transfer.cancelledAt,
    events: transfer.events.map((e) => ({
      id: e.id,
      type: e.type,
      actorUserId: e.actorUserId,
      payload: eventPayloadFor(e, viewer),
      createdAt: e.createdAt,
    })),
    myRole: viewer.isStaff ? 'STAFF' : viewer.role,
    nextActions: transferNextActions(transfer, viewer),
    disclaimer: TRANSFER_DISCLAIMER_FR,
  };
}

/** Receipt — explicitly marked as a simulation on every line of the text version. */
export function toTransferReceipt(transfer: TransferWithRelations) {
  const src = transfer.sourceCurrency;
  const dst = transfer.destinationCurrency;
  const beneficiary = (transfer.beneficiary ?? {}) as Record<string, unknown>;
  return {
    simulated: true as const,
    disclaimer: TRANSFER_DISCLAIMER_FR,
    title: 'Reçu de transfert simulé — Diaspora Trust SANDBOX',
    reference: transfer.reference,
    status: transfer.status,
    organization: transfer.organization
      ? { id: transfer.organization.id, name: transfer.organization.name }
      : null,
    corridor: { origin: transfer.originCountry, destination: transfer.destinationCountry },
    beneficiary: {
      name: beneficiary.name ?? null,
      country: beneficiary.country ?? null,
      currencyCode: beneficiary.currencyCode ?? null,
      method: beneficiary.method ?? null,
      accountIdentifierMasked: beneficiary.accountIdentifierMasked ?? null,
      institutionName: beneficiary.institutionName ?? null,
    },
    source: moneyDto(transfer.sourceAmountMinor, src),
    fee: moneyDto(transfer.feeMinor, src),
    totalDebit: moneyDto(transfer.sourceAmountMinor + transfer.feeMinor, src),
    destination: moneyDto(transfer.destinationAmountMinor, dst),
    rate: rateDisplay(transfer.rateNumerator, transfer.rateDenominator, src, dst),
    provider: transfer.provider?.code ?? null,
    externalRef: transfer.externalRef,
    failureReason: transfer.failureReason,
    ledger: {
      sourceLedgerTransactionId: transfer.sourceLedgerTransactionId,
      destinationLedgerTransactionId: transfer.destinationLedgerTransactionId,
      reversalLedgerTransactionId: transfer.reversalLedgerTransactionId,
    },
    createdAt: transfer.createdAt,
    authorizedAt: transfer.authorizedAt,
    settledAt: transfer.settledAt,
    failedAt: transfer.failedAt,
    issuedAt: new Date(),
  };
}

export function receiptToText(receipt: ReturnType<typeof toTransferReceipt>): string {
  const line = (label: string, value: unknown) => `${label.padEnd(26, ' ')}${value ?? '—'}`;
  const money = (m: { decimal: string; currency: string } | null) => (m ? `${m.decimal} ${m.currency}` : '—');
  return [
    '=== DIASPORA TRUST — SANDBOX ===',
    `*** ${receipt.disclaimer} / Simulated data — no real funds ***`,
    receipt.title,
    '',
    line('Référence', receipt.reference),
    line('Statut', receipt.status),
    line('Organisation', receipt.organization?.name),
    line('Corridor', `${receipt.corridor.origin} → ${receipt.corridor.destination}`),
    line('Bénéficiaire', receipt.beneficiary.name),
    line('Compte (masqué)', receipt.beneficiary.accountIdentifierMasked),
    line('Institution', receipt.beneficiary.institutionName),
    line('Montant envoyé (fictif)', money(receipt.source)),
    line('Frais (fictifs)', money(receipt.fee)),
    line('Total débité (fictif)', money(receipt.totalDebit)),
    line('Montant reçu (fictif)', money(receipt.destination)),
    line('Taux simulé', receipt.rate),
    line('Partenaire simulé', receipt.provider),
    line('Référence externe', receipt.externalRef),
    line('Créé le', receipt.createdAt.toISOString()),
    line('Autorisé le', receipt.authorizedAt?.toISOString()),
    line('Réglé le', receipt.settledAt?.toISOString()),
    line('Échoué le', receipt.failedAt?.toISOString()),
    line('Motif d’échec', receipt.failureReason),
    line('Écriture source', receipt.ledger.sourceLedgerTransactionId),
    line('Écriture destination', receipt.ledger.destinationLedgerTransactionId),
    line('Contre-passation', receipt.ledger.reversalLedgerTransactionId),
    line('Émis le', receipt.issuedAt.toISOString()),
    '',
    `*** ${receipt.disclaimer} — ce reçu ne constitue pas une preuve de paiement. ***`,
  ].join('\n');
}
