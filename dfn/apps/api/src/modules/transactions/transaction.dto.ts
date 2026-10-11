import { computeFeeMinor, minorToDecimalString } from '@dfn/shared';
import { moneyDto } from '../../common/serialize';
import type { TransactionWithRelations, ViewerRole } from './transaction-access.service';

export interface VerificationSnapshot {
  buyerIdentity: string;
  sellerIdentity: string;
  required: boolean;
  fundingAllowed: boolean;
  reasons: string[];
}

export function nextActionsFor(
  tx: TransactionWithRelations,
  role: ViewerRole,
  verification: VerificationSnapshot,
  userId: string,
): string[] {
  const actions: string[] = [];
  const buyerParty = tx.parties.find((p) => p.role === 'BUYER');
  const sellerParty = tx.parties.find((p) => p.role === 'SELLER');
  const version = tx.contract?.currentVersion;
  const myParty = role === 'BUYER' ? buyerParty : role === 'SELLER' ? sellerParty : undefined;
  const acceptedByMe = Boolean(
    version && myParty && version.acceptances.some((a) => a.partyId === myParty.id),
  );

  if (tx.status === 'PENDING_ACCEPTANCE') {
    if (role === 'BUYER') actions.push('RESEND_INVITATION', 'CANCEL');
    if (role === 'SELLER' && sellerParty?.status === 'INVITED')
      actions.push('ACCEPT_INVITATION', 'DECLINE_INVITATION');
    if (role !== 'STAFF' && myParty?.status === 'ACCEPTED' && version && !acceptedByMe)
      actions.push('ACCEPT_TERMS');
  }
  if (tx.status === 'ACCEPTED') {
    if (role !== 'STAFF' && !acceptedByMe && version) actions.push('ACCEPT_TERMS');
    if (role === 'BUYER' && verification.fundingAllowed && tx.contract?.status === 'ACCEPTED')
      actions.push('REQUEST_FUNDING');
    if (role !== 'STAFF') actions.push('CANCEL');
  }
  if (tx.status === 'AWAITING_FUNDING') {
    const pending = tx.fundingRequests.find((f) => f.status === 'PENDING');
    if (pending && (role === 'BUYER' || role === 'STAFF')) actions.push('SIMULATE_PARTNER_CONFIRMATION');
    if (!pending && role === 'BUYER') actions.push('REQUEST_FUNDING');
    if (role === 'BUYER') actions.push('CANCEL');
  }
  if (tx.status === 'FUNDED' || tx.status === 'IN_PROGRESS' || tx.status === 'DISPUTED') {
    const openMilestones = tx.milestones.filter((m) => ['PENDING', 'CHANGES_REQUESTED'].includes(m.status));
    const submitted = tx.milestones.filter((m) => m.status === 'SUBMITTED');
    if (role === 'SELLER' && openMilestones.length) actions.push('SUBMIT_MILESTONE');
    if (role === 'BUYER' && submitted.length && !tx.releaseFrozen)
      actions.push('APPROVE_MILESTONE', 'REQUEST_CHANGES');
    if (role === 'BUYER' && submitted.length && tx.releaseFrozen) actions.push('REQUEST_CHANGES');
    const openDispute = tx.disputes.find((d) => d.status !== 'CLOSED');
    if (!openDispute && role !== 'STAFF' && tx.status !== 'DISPUTED') actions.push('OPEN_DISPUTE');
    if (!openDispute && role === 'BUYER' && tx.status !== 'DISPUTED') actions.push('REQUEST_REFUND');
    if (openDispute) actions.push('VIEW_DISPUTE');
  }
  if (!['SETTLED', 'REFUNDED', 'CANCELLED', 'EXPIRED'].includes(tx.status) && role !== 'STAFF')
    actions.push('UPLOAD_DOCUMENT');
  void userId;
  return actions;
}

export function toTransactionDto(
  tx: TransactionWithRelations,
  role: ViewerRole,
  extras: { escrowBalanceMinor: bigint; verification: VerificationSnapshot; userId: string },
) {
  const ccy = tx.currencyCode;
  const buyerParty = tx.parties.find((p) => p.role === 'BUYER');
  const sellerParty = tx.parties.find((p) => p.role === 'SELLER');
  const version = tx.contract?.currentVersion;
  const releasedMinor = tx.milestones
    .filter((m) => m.status === 'RELEASED')
    .reduce((a, m) => a + m.amountMinor, 0n);
  const refundedMinor = tx.milestones
    .filter((m) => m.status === 'REFUNDED')
    .reduce((a, m) => a + m.amountMinor, 0n);
  const party = (p: typeof buyerParty) =>
    p
      ? {
          id: p.id,
          role: p.role,
          status: p.status,
          invitedEmail:
            role === 'STAFF' || p.role === 'BUYER' || p.userId ? p.invitedEmail : maskEmail(p.invitedEmail),
          invitedName: p.invitedName,
          acceptedAt: p.acceptedAt,
          organization: p.organization,
          user: p.user ? { id: p.user.id, firstName: p.user.firstName, lastName: p.user.lastName } : null,
        }
      : null;
  const latestFunding = tx.fundingRequests[0];
  return {
    id: tx.id,
    reference: tx.reference,
    title: tx.title,
    description: tx.description,
    category: tx.category,
    status: tx.status,
    releaseFrozen: tx.releaseFrozen,
    currencyCode: ccy,
    amount: moneyDto(tx.amountMinor, ccy),
    fee: moneyDto(tx.feeMinor, ccy),
    feeBps: tx.feeBps,
    totalToFund: moneyDto(tx.amountMinor + tx.feeMinor, ccy),
    escrowBalance: moneyDto(extras.escrowBalanceMinor, ccy),
    releasedTotal: moneyDto(releasedMinor, ccy),
    refundedTotal: moneyDto(refundedMinor, ccy),
    originCountry: tx.originCountry,
    destinationCountry: tx.destinationCountry,
    buyer: party(buyerParty),
    seller: party(sellerParty),
    myRole: role,
    contract: tx.contract
      ? {
          id: tx.contract.id,
          status: tx.contract.status,
          currentVersion: version
            ? {
                id: version.id,
                version: version.version,
                templateCode: version.templateCode,
                templateVersion: version.templateVersion,
                contentHash: version.contentHash,
                bodyText: version.bodyText,
                terms: version.terms,
                acceptances: version.acceptances.map((a) => ({
                  partyRole: a.party.role,
                  acceptedAt: a.acceptedAt,
                })),
                acceptedByBuyer: version.acceptances.some((a) => a.party.role === 'BUYER'),
                acceptedBySeller: version.acceptances.some((a) => a.party.role === 'SELLER'),
              }
            : null,
        }
      : null,
    milestones: tx.milestones.map((m) => ({
      id: m.id,
      sequence: m.sequence,
      title: m.title,
      description: m.description,
      amount: moneyDto(m.amountMinor, ccy),
      requiredEvidence: m.requiredEvidence,
      status: m.status,
      submittedAt: m.submittedAt,
      approvedAt: m.approvedAt,
      releasedAt: m.releasedAt,
      rejectionNote: m.rejectionNote,
      ledgerTransactionId: m.ledgerTransactionId,
      evidences: m.evidences.map((e) => ({
        id: e.id,
        note: e.note,
        createdAt: e.createdAt,
        document: e.document,
      })),
    })),
    funding: latestFunding
      ? {
          id: latestFunding.id,
          reference: latestFunding.reference,
          status: latestFunding.status,
          amount: moneyDto(latestFunding.amountMinor, ccy),
          instructions: latestFunding.instructions,
          provider: latestFunding.provider,
          expiresAt: latestFunding.expiresAt,
          confirmedAt: latestFunding.confirmedAt,
        }
      : null,
    verification: extras.verification,
    disputes: tx.disputes,
    documentCount: tx._count.documents,
    nextActions: nextActionsFor(tx, role, extras.verification, extras.userId),
    acceptedAt: tx.acceptedAt,
    fundedAt: tx.fundedAt,
    settledAt: tx.settledAt,
    cancelledAt: tx.cancelledAt,
    expiresAt: tx.expiresAt,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    sandbox: true,
  };
}

export function toTransactionSummary(tx: TransactionWithRelations, role: ViewerRole) {
  const ccy = tx.currencyCode;
  const counterpart =
    role === 'BUYER'
      ? tx.parties.find((p) => p.role === 'SELLER')
      : tx.parties.find((p) => p.role === 'BUYER');
  return {
    id: tx.id,
    reference: tx.reference,
    title: tx.title,
    category: tx.category,
    status: tx.status,
    releaseFrozen: tx.releaseFrozen,
    amount: moneyDto(tx.amountMinor, ccy),
    currencyCode: ccy,
    originCountry: tx.originCountry,
    destinationCountry: tx.destinationCountry,
    myRole: role,
    counterpart: counterpart
      ? {
          name:
            counterpart.organization?.name ?? counterpart.invitedName ?? maskEmail(counterpart.invitedEmail),
          status: counterpart.status,
        }
      : null,
    milestoneProgress: {
      total: tx.milestones.length,
      released: tx.milestones.filter((m) => m.status === 'RELEASED').length,
      submitted: tx.milestones.filter((m) => m.status === 'SUBMITTED').length,
    },
    openDisputes: tx.disputes.filter((d) => d.status !== 'CLOSED').length,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
  };
}

export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain ?? ''}`;
}

export function feeFor(amountMinor: bigint, feeBps: number) {
  return computeFeeMinor(amountMinor, feeBps);
}

export function decimal(amountMinor: bigint, ccy: string) {
  return minorToDecimalString(amountMinor, ccy);
}
