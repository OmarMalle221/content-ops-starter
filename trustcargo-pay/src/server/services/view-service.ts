import { toDTO } from '@/domain/money';
import { UPLOAD_PERMISSIONS } from '@/domain/documents';
import { checkVin } from '@/domain/vehicle/vin';
import { diffTerms } from '@/domain/transaction/contract';
import { isTerminal, PRE_FUNDING_STATUSES } from '@/domain/transaction/state-machine';
import type { TransactionView } from '@/lib/dto';
import type { PlatformRole } from '@/domain/model';
import type { Actor } from '@/server/auth/actor';
import { hasRole } from '@/server/auth/actor';
import type { MockPaymentProvider } from '@/server/adapters/mock/mock-payment-provider';
import { accessTransaction, staffMfaIsRecent, type Deps } from './context';
import type { DocumentService } from './document-service';
import type { PaymentService } from './payment-service';
import type { RiskService } from './risk-service';
import type { Workflow } from './workflow';
import { activeMilestone, currentMilestones } from './workflow';

/** Actions hidden from parties in the timeline (internal compliance work, no tipping-off). */
const INTERNAL_ACTIONS = /^(risk\.|compliance\.|kyc\.|provider_event\.|payout\.blocked|document\.access_denied|party\.invitation_rejected)/;

export class ViewService {
    constructor(
        private readonly deps: Deps,
        private readonly workflow: Workflow,
        private readonly documents: DocumentService,
        private readonly payments: PaymentService,
        private readonly risk: RiskService,
        private readonly simulator?: MockPaymentProvider
    ) {}

    async transaction(actor: Actor, transactionId: string): Promise<TransactionView> {
        return this.deps.uow.run(async (db) => {
            const access = await accessTransaction(db, actor, transactionId);
            const { tx, party } = access;
            // Staff visibility in this view needs the same recent MFA as the back office (defence in depth: getActor
            // already strips roles without it).
            const staffOk = await staffMfaIsRecent(db, actor, this.deps.clock.now());
            const staffRole = (...roles: PlatformRole[]) => staffOk && hasRole(actor, ...roles);
            const me = (await db.users.get(actor.userId))!;
            const role = party?.role;
            const isPrincipal = role === 'SELLER' || role === 'BUYER';
            const staffPayments = staffRole('finance_operator', 'compliance_analyst', 'dispute_manager', 'auditor');
            const parties = await db.transactionParties.findBy({ transactionId });
            const vehicle = await db.vehicles.findOne({ transactionId });
            const corridor = await db.corridors.get(tx.corridorId);
            const version = tx.currentContractVersionId ? await db.contractVersions.get(tx.currentContractVersionId) : undefined;
            const versions = (await db.contractVersions.findBy({ transactionId })).sort((a, b) => a.versionNumber - b.versionNumber);
            const previousVersion = version ? versions.find((v) => v.versionNumber === version.versionNumber - 1) : undefined;
            const acceptances = version ? await db.contractAcceptances.findBy({ contractVersionId: version.id }) : [];
            const milestones = await currentMilestones(db, tx);
            const payouts = await db.payouts.findBy({ transactionId });
            const refunds = await db.refunds.findBy({ transactionId });
            const instructions = (await db.paymentInstructions.findBy({ transactionId })).sort((a, b) =>
                b.createdAt.localeCompare(a.createdAt)
            );
            const disputes = (await db.disputes.findBy({ transactionId })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            const docs = await db.documents.findBy({ transactionId });
            const ctx = await this.workflow.buildContext(db, tx);
            const blocking = await this.risk.blockingAlerts(db, transactionId);
            const holds = await db.complianceHolds.findBy({ transactionId });
            const activeHold = holds.some((h) => h.status === 'ACTIVE');
            const users = new Map((await db.users.list()).map((u) => [u.id, u]));

            const viewDocs = [];
            for (const d of docs.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))) {
                const canOpen = await this.documents.canView(db, actor, d);
                if (!canOpen && !staffRole('auditor')) continue;
                viewDocs.push({
                    id: d.id,
                    logicalId: d.logicalId,
                    version: d.version,
                    type: d.type,
                    title: d.title,
                    fileName: d.fileName,
                    mimeType: d.mimeType,
                    sizeBytes: d.sizeBytes,
                    sha256: d.sha256,
                    status: d.status,
                    uploadedAt: d.uploadedAt,
                    uploadedBy: parties.find((p) => p.userId === d.ownerUserId)?.displayName ?? users.get(d.ownerUserId)?.fullName ?? '—',
                    extracted: d.extracted,
                    extractionSource: d.extractionSource,
                    scanStatus: d.scan.status,
                    canOpen: canOpen && d.scan.status === 'CLEAN',
                    isMine: d.ownerUserId === actor.userId
                });
            }
            const visibleDocIds = new Set(viewDocs.map((d) => d.id));
            const active = activeMilestone(milestones);
            const openDispute = disputes.find((d) => !['RESOLVED', 'WITHDRAWN', 'ARCHIVED'].includes(d.status));

            const viewMilestones = [];
            for (const m of milestones.filter((x) => x.status !== 'CANCELLED')) {
                const evidence = await db.milestoneEvidence.findBy({ milestoneId: m.id });
                const evDocs = (await Promise.all(evidence.map((e) => db.documents.get(e.documentId)))).filter(
                    (d): d is NonNullable<typeof d> => Boolean(d)
                );
                const live = evDocs.filter((d) => !['SUPERSEDED', 'REJECTED', 'QUARANTINED', 'SCAN_PENDING'].includes(d.status));
                const payout = payouts.filter((p) => p.milestoneId === m.id).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
                viewMilestones.push({
                    id: m.id,
                    sequence: m.sequence,
                    title: m.title,
                    description: m.description,
                    shareBps: m.shareBps,
                    amount: toDTO(m.amount),
                    status: m.status,
                    requiredEvidence: m.requiredEvidence,
                    evidence: evDocs
                        .filter((d) => visibleDocIds.has(d.id))
                        .map((d) => ({ documentId: d.id, type: d.type, title: d.title, status: d.status })),
                    missingEvidence: m.requiredEvidence.filter((t) => !live.some((d) => d.type === t)),
                    submittedAt: m.submittedAt,
                    submissionNote: m.submissionNote,
                    changeRequestReason: m.changeRequestReason,
                    payout:
                        payout && (isPrincipal || staffPayments)
                            ? { status: payout.status, amount: toDTO(payout.amount), failureReason: payout.failureReason }
                            : undefined
                });
            }

            const myAcceptance = acceptances.find((a) => a.partyId === party?.id);
            const canWrite = Boolean(party) && !isTerminal(tx.status);
            const canSeePayments = isPrincipal || staffPayments;
            const audits = (await db.auditEvents.findBy({ transactionId })).sort((a, b) => b.sequence - a.sequence);
            const actorName = (id?: string, type?: string) => {
                if (type === 'PROVIDER') return 'Partenaire financier';
                if (type === 'SYSTEM') return 'Système';
                const p = parties.find((x) => x.userId === id);
                if (p) return p.displayName;
                const u = id ? users.get(id) : undefined;
                return u?.platformRoles.length ? 'Équipe TrustCargo' : (u?.fullName ?? '—');
            };

            const view: TransactionView = {
                id: tx.id,
                reference: tx.reference,
                title: tx.title,
                status: tx.status,
                amount: toDTO(tx.amount),
                corridorCode: corridor?.code ?? '',
                createdAt: tx.createdAt,
                updatedAt: tx.updatedAt,
                fundedAt: tx.fundedAt,
                closedAt: tx.closedAt,
                cancellationReason: tx.cancellationReason,
                isDemo: tx.isDemo,
                viewer: {
                    userId: actor.userId,
                    partyRole: role,
                    staff: access.staff,
                    viaOrganization: access.viaOrganization,
                    kycStatus: me.kycStatus
                },
                can: {
                    sendInvitations: role === 'SELLER' && tx.status === 'DRAFT',
                    regenerateInvitation:
                        role === 'SELLER' && !isTerminal(tx.status) && tx.status !== 'DRAFT' && parties.some((p) => p.status === 'INVITED'),
                    decideContract:
                        isPrincipal &&
                        !myAcceptance &&
                        ['DRAFT', 'AWAITING_PARTIES', 'IDENTITY_VERIFICATION', 'AWAITING_AGREEMENT'].includes(tx.status),
                    amendContract:
                        role === 'SELLER' && (PRE_FUNDING_STATUSES as readonly string[]).includes(tx.status) && !ctx.fundingStarted,
                    requestFunding: role === 'BUYER' && tx.status === 'AWAITING_FUNDING',
                    uploadDocuments: canWrite,
                    uploadableTypes: role ? UPLOAD_PERMISSIONS[role] : [],
                    submitMilestone: role === 'SELLER' && tx.status === 'IN_PROGRESS' && Boolean(active),
                    reviewMilestone: role === 'BUYER' && tx.status === 'MILESTONE_REVIEW',
                    openDispute: isPrincipal && ['FUNDS_CONFIRMED', 'IN_PROGRESS', 'MILESTONE_REVIEW'].includes(tx.status) && !openDispute,
                    cancel: isPrincipal && (PRE_FUNDING_STATUSES as readonly string[]).includes(tx.status) && !ctx.fundingStarted,
                    viewPayments: canSeePayments,
                    viewRisk: staffRole('compliance_analyst', 'auditor', 'dispute_manager'),
                    simulatePartner:
                        Boolean(this.simulator) && this.deps.config.mode === 'demo' && (isPrincipal || staffRole('finance_operator'))
                },
                blockedReasons: [
                    ...(activeHold ? ['UNDER_COMPLIANCE_REVIEW'] : []),
                    ...(blocking.length ? ['UNDER_RISK_REVIEW'] : []),
                    ...(openDispute ? ['DISPUTE_OPEN'] : [])
                ],
                underReview: activeHold || blocking.length > 0,
                parties: parties
                    .filter((p) => p.status !== 'REMOVED')
                    .map((p) => ({
                        id: p.id,
                        role: p.role,
                        displayName: p.displayName,
                        email: p.email,
                        status: p.status,
                        kycStatus: p.userId ? users.get(p.userId)?.kycStatus : undefined,
                        joinedAt: p.joinedAt,
                        isMe: p.userId === actor.userId
                    })),
                vehicle: vehicle
                    ? (() => {
                          const { transactionId: _t, ...v } = vehicle;
                          const check = checkVin(vehicle.vin);
                          return { ...v, vinStructurallyValid: check.structurallyValid, vinCheckDigitEvaluated: check.checkDigitEvaluated };
                      })()
                    : undefined,
                contract: version
                    ? {
                          currentVersionId: version.id,
                          versionNumber: version.versionNumber,
                          contentHash: version.contentHash,
                          status: version.status,
                          terms: version.terms,
                          changedFields: previousVersion ? diffTerms(previousVersion.terms, version.terms) : [],
                          changeSummary: version.changeSummary,
                          createdAt: version.createdAt,
                          acceptances: acceptances.map((a) => ({
                              partyId: a.partyId,
                              role: parties.find((p) => p.id === a.partyId)!.role,
                              decision: a.decision,
                              decidedAt: a.decidedAt,
                              comment: a.comment
                          })),
                          history: versions.map((v) => ({
                              id: v.id,
                              versionNumber: v.versionNumber,
                              status: v.status,
                              createdAt: v.createdAt,
                              changeSummary: v.changeSummary,
                              contentHash: v.contentHash
                          }))
                      }
                    : undefined,
                milestones: viewMilestones,
                documents: viewDocs,
                payment: canSeePayments
                    ? {
                          instruction:
                              instructions[0] && (role === 'BUYER' || staffPayments)
                                  ? {
                                        id: instructions[0].id,
                                        providerReference: instructions[0].providerReference,
                                        status: instructions[0].status,
                                        amount: toDTO(instructions[0].amount),
                                        details: instructions[0].details,
                                        expiresAt: instructions[0].expiresAt
                                    }
                                  : undefined,
                          heldMinor: (await this.payments.heldAmount(db, tx)).amountMinor.toString(),
                          payouts: payouts
                              .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
                              .map((p) => ({
                                  id: p.id,
                                  status: p.status,
                                  amount: toDTO(p.amount),
                                  providerReference: p.providerReference,
                                  requestedAt: p.requestedAt,
                                  failureReason: p.failureReason,
                                  attempts: p.attempts,
                                  milestoneTitle: milestones.find((m) => m.id === p.milestoneId)?.title
                              })),
                          refunds: refunds.map((r) => ({
                              id: r.id,
                              status: r.status,
                              amount: toDTO(r.amount),
                              providerReference: r.providerReference,
                              requestedAt: r.requestedAt,
                              failureReason: r.failureReason
                          })),
                          providerSimulated: this.deps.payments.simulated
                      }
                    : undefined,
                disputes:
                    isPrincipal || staffRole('dispute_manager', 'auditor', 'compliance_analyst')
                        ? await Promise.all(
                              disputes.map(async (d) => {
                                  const decision = (await db.disputeDecisions.findBy({ disputeId: d.id }))[0];
                                  return {
                                      id: d.id,
                                      reason: d.reason,
                                      status: d.status,
                                      description: d.description,
                                      requestedOutcome: d.requestedOutcome,
                                      openedByRole: d.openedByRole,
                                      openedByMe: d.openedBy === actor.userId,
                                      responseDueAt: d.responseDueAt,
                                      createdAt: d.createdAt,
                                      messages: (await db.disputeMessages.findBy({ disputeId: d.id }))
                                          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                                          .map((m) => ({
                                              id: m.id,
                                              authorRole: m.authorRole,
                                              body: m.body,
                                              createdAt: m.createdAt,
                                              mine: m.authorId === actor.userId,
                                              documentIds: m.documentIds
                                          })),
                                      decision: decision
                                          ? {
                                                outcome: decision.outcome,
                                                sellerAmount: toDTO(decision.sellerAmount),
                                                buyerRefundAmount: toDTO(decision.buyerRefundAmount),
                                                rationale: decision.rationale,
                                                contractClause: decision.contractClause,
                                                createdAt: decision.createdAt
                                            }
                                          : undefined
                                  };
                              })
                          )
                        : [],
                risk: staffRole('compliance_analyst', 'auditor', 'dispute_manager')
                    ? (await db.riskAlerts.findBy({ transactionId })).map((a) => ({
                          id: a.id,
                          ruleId: a.ruleId,
                          severity: a.severity,
                          status: a.status,
                          reasons: a.reasons,
                          recommendedAction: a.recommendedAction,
                          blocksFundsMovement: a.blocksFundsMovement,
                          createdAt: a.createdAt
                      }))
                    : undefined,
                holds: staffRole('compliance_analyst', 'auditor')
                    ? holds.map((h) => ({ id: h.id, type: h.type, status: h.status, reference: h.reference, placedAt: h.placedAt }))
                    : undefined,
                timeline: audits
                    .filter((e) => access.staff || !INTERNAL_ACTIONS.test(e.action))
                    .filter((e) => canSeePayments || !/^(payment|payout|refund)\./.test(e.action))
                    .slice(0, 200)
                    .map((e) => ({
                        id: e.id,
                        at: e.at,
                        action: e.action,
                        actor: actorName(e.actorId, e.actorType),
                        metadata: Object.fromEntries(
                            Object.entries(e.metadata).filter(([k]) =>
                                ['from', 'to', 'role', 'type', 'reason', 'decision', 'outcome', 'versionNumber', 'sequence'].includes(k)
                            )
                        )
                    })),
                simulator:
                    this.simulator && this.deps.config.mode === 'demo'
                        ? {
                              instructionReference: instructions.find((i) => i.status === 'CREATED' || i.status === 'PENDING')
                                  ?.providerReference,
                              transfers: [
                                  ...payouts.map((p) => ({ ref: p.providerReference, kind: 'PAYOUT' as const, status: p.status })),
                                  ...refunds.map((r) => ({ ref: r.providerReference, kind: 'REFUND' as const, status: r.status }))
                              ]
                                  .filter((t) => t.ref && (t.status === 'SUBMITTED' || t.status === 'PROCESSING'))
                                  .map((t) => ({ reference: t.ref!, kind: t.kind, status: t.status }))
                          }
                        : undefined
            };
            return view;
        });
    }

    async comparison(actor: Actor, transactionId: string) {
        return this.documents.comparison(actor, transactionId);
    }
}
