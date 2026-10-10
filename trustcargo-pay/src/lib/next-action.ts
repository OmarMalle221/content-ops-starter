import type { TransactionView } from './dto';

export type NextAction = { key: string; tab: string; mine: boolean };

/** Derives the most relevant next step for the viewer (presentation only — never used to authorise). */
export function nextActionFor(view: TransactionView): NextAction {
    const role = view.viewer.partyRole;
    const c = view.can;
    if (c.sendInvitations) return { key: 'sendInvitations', tab: 'overview', mine: true };
    if (c.decideContract && view.viewer.kycStatus !== 'VERIFIED') return { key: 'verifyIdentity', tab: 'contract', mine: true };
    if (c.decideContract && ['AWAITING_AGREEMENT', 'AWAITING_PARTIES', 'IDENTITY_VERIFICATION'].includes(view.status))
        return { key: 'decideContract', tab: 'contract', mine: true };
    if (c.requestFunding) return { key: 'requestFunding', tab: 'payments', mine: true };
    if (c.reviewMilestone) return { key: 'reviewMilestone', tab: 'milestones', mine: true };
    if (c.submitMilestone) return { key: 'submitMilestone', tab: 'milestones', mine: true };
    const openDispute = view.disputes.find((d) => d.status === 'AWAITING_RESPONSE' && !d.openedByMe);
    if (openDispute && role) return { key: 'disputeResponse', tab: 'disputes', mine: true };
    if (
        ['FUNDING_PENDING', 'REFUND_PENDING'].includes(view.status) ||
        view.payment?.payouts.some((p) => ['REQUESTED', 'SUBMITTED', 'PROCESSING'].includes(p.status))
    ) {
        return { key: 'waitingPartner', tab: 'payments', mine: false };
    }
    if (view.status === 'DISPUTED' || view.underReview) return { key: 'waitingReview', tab: 'overview', mine: false };
    if (['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(view.status)) return { key: 'none', tab: 'overview', mine: false };
    return { key: 'waitingCounterparty', tab: 'overview', mine: false };
}
