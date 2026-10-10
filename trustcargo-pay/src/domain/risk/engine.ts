/**
 * Extensible, explainable risk rules engine.
 *
 * Each rule returns findings with machine-readable reason codes and parameters, a priority level
 * and a recommended action. The engine deliberately does NOT produce a numeric fraud probability:
 * rules are heuristics that route cases to human review; they are not statistically validated.
 *
 * Local checks never certify absence of theft, liens or sanctions — those results must come from
 * authorised providers (ScreeningResult, VehicleHistoryProvider) and are only relayed here.
 */
import { checkVin, normalizeVin } from '../vehicle/vin';
import { matchesAny, namesMatch } from './names';
import type {
    Corridor,
    ContractVersion,
    Document,
    DocumentType,
    IdentityVerification,
    Organization,
    PaymentAccount,
    RiskCategory,
    RiskReason,
    RiskSeverity,
    ScreeningResult,
    SessionEvent,
    Transaction,
    TransactionParty,
    User,
    Vehicle
} from '../model';

export interface PartyFacts {
    party: TransactionParty;
    user?: User;
    organization?: Organization;
    kyc?: IdentityVerification;
    screening?: ScreeningResult;
    payoutAccounts: PaymentAccount[];
    sessions: SessionEvent[];
}

export interface RiskContext {
    now: Date;
    transaction: Transaction;
    corridor?: Corridor;
    parties: PartyFacts[];
    vehicle?: Vehicle;
    documents: Document[];
    contractVersions: ContractVersion[];
    sellerTransactionsLast24h: number;
    sellerPastAmountsMinor: bigint[];
    coolingOffHours: number;
}

export interface Finding {
    fingerprint: string;
    reasons: RiskReason[];
    subjectUserId?: string;
    severity?: RiskSeverity;
}

export interface RiskRule {
    id: string;
    category: RiskCategory;
    severity: RiskSeverity;
    blocksFundsMovement: boolean;
    recommendedAction: string;
    /** Alert may be closed by the system when the condition is no longer detected. */
    autoResolvable: boolean;
    evaluate(ctx: RiskContext): Finding[];
}

export interface RiskAlertDraft extends Finding {
    ruleId: string;
    category: RiskCategory;
    severity: RiskSeverity;
    blocksFundsMovement: boolean;
    recommendedAction: string;
    autoResolvable: boolean;
}

const HOUR = 3_600_000;
const POST_AGREEMENT: Transaction['status'][] = [
    'AWAITING_FUNDING',
    'FUNDING_PENDING',
    'FUNDS_CONFIRMED',
    'IN_PROGRESS',
    'MILESTONE_REVIEW',
    'DISPUTED'
];

const principals = (ctx: RiskContext) => ctx.parties.filter((p) => p.party.role === 'SELLER' || p.party.role === 'BUYER');
const seller = (ctx: RiskContext) => ctx.parties.find((p) => p.party.role === 'SELLER');
const buyer = (ctx: RiskContext) => ctx.parties.find((p) => p.party.role === 'BUYER');
const liveDocs = (ctx: RiskContext, type?: DocumentType) =>
    ctx.documents.filter(
        (d) => d.status !== 'SUPERSEDED' && d.status !== 'REJECTED' && d.status !== 'QUARANTINED' && (!type || d.type === type)
    );
const sellerNames = (s?: PartyFacts) => [s?.user?.fullName, s?.organization?.legalName, s?.organization?.tradeName, s?.kyc?.verifiedName];
const activePayout = (p?: PartyFacts) => p?.payoutAccounts.filter((a) => a.status !== 'DISABLED') ?? [];

export const RULES: RiskRule[] = [
    /* ----------------------------------------------------------------- user */
    {
        id: 'USER_IDENTITY_NOT_VERIFIED',
        category: 'USER',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'COMPLETE_KYC',
        autoResolvable: true,
        evaluate: (ctx) =>
            POST_AGREEMENT.includes(ctx.transaction.status)
                ? principals(ctx)
                      .filter((p) => p.user && p.user.kycStatus !== 'VERIFIED')
                      .map((p) => ({
                          fingerprint: `${p.user!.id}:${p.user!.kycStatus}`,
                          subjectUserId: p.user!.id,
                          reasons: [{ code: 'KYC_STATUS', params: { role: p.party.role, status: p.user!.kycStatus } }]
                      }))
                : []
    },
    {
        id: 'USER_ID_DOCUMENT_EXPIRED',
        category: 'USER',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'REQUEST_VALID_ID',
        autoResolvable: true,
        evaluate: (ctx) =>
            principals(ctx)
                .filter((p) => p.kyc?.documentExpiresAt && new Date(p.kyc.documentExpiresAt) < ctx.now)
                .map((p) => ({
                    fingerprint: `${p.kyc!.id}`,
                    subjectUserId: p.user?.id,
                    reasons: [{ code: 'ID_EXPIRED', params: { role: p.party.role, expiredOn: p.kyc!.documentExpiresAt! } }]
                }))
    },
    {
        id: 'USER_NAME_MISMATCH',
        category: 'USER',
        severity: 'MEDIUM',
        blocksFundsMovement: false,
        recommendedAction: 'REQUEST_NAME_EXPLANATION',
        autoResolvable: false,
        evaluate: (ctx) =>
            principals(ctx)
                .filter((p) => p.user && p.kyc?.verifiedName && !namesMatch(p.user.fullName, p.kyc.verifiedName))
                .map((p) => ({
                    fingerprint: `${p.user!.id}:${p.kyc!.verifiedName}`,
                    subjectUserId: p.user!.id,
                    reasons: [{ code: 'PROFILE_VS_ID_NAME', params: { profileName: p.user!.fullName, idName: p.kyc!.verifiedName! } }]
                }))
    },
    {
        id: 'PAYOUT_ACCOUNT_HOLDER_MISMATCH',
        category: 'USER',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'VERIFY_BENEFICIARY',
        autoResolvable: true,
        evaluate: (ctx) => {
            const s = seller(ctx);
            return activePayout(s)
                .filter((a) => !matchesAny(a.holderName, sellerNames(s)))
                .map((a) => ({
                    fingerprint: a.id,
                    subjectUserId: s?.user?.id,
                    reasons: [{ code: 'HOLDER_DIFFERS_FROM_SELLER', params: { holder: a.holderName, seller: s?.party.displayName ?? '' } }]
                }));
        }
    },
    {
        id: 'BENEFICIARY_CHANGED_RECENTLY',
        category: 'USER',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'CONFIRM_CHANGE_OUT_OF_BAND',
        autoResolvable: false,
        evaluate: (ctx) => {
            const s = seller(ctx);
            return activePayout(s)
                .filter((a) => a.replacesAccountId && ctx.now.getTime() - new Date(a.createdAt).getTime() < ctx.coolingOffHours * HOUR)
                .map((a) => ({
                    fingerprint: a.id,
                    subjectUserId: s?.user?.id,
                    reasons: [{ code: 'PAYOUT_ACCOUNT_REPLACED', params: { changedAt: a.createdAt, coolingOffHours: ctx.coolingOffHours } }]
                }));
        }
    },
    {
        id: 'UNUSUAL_LOGIN',
        category: 'USER',
        severity: 'LOW',
        blocksFundsMovement: false,
        recommendedAction: 'MONITOR',
        autoResolvable: false,
        evaluate: (ctx) =>
            principals(ctx).flatMap((p) => {
                if (!p.user || p.sessions.length < 2) return [];
                const sorted = [...p.sessions].sort((a, b) => a.at.localeCompare(b.at));
                const latest = sorted[sorted.length - 1]!;
                const previous = sorted.slice(0, -1);
                const knownCountries = new Set([p.user.country, ...previous.map((s) => s.country)]);
                if (knownCountries.has(latest.country)) return [];
                return [
                    {
                        fingerprint: `${p.user.id}:${latest.id}`,
                        subjectUserId: p.user.id,
                        reasons: [{ code: 'NEW_LOGIN_COUNTRY', params: { country: latest.country, at: latest.at } }]
                    }
                ];
            })
    },
    {
        id: 'LINKED_ACCOUNTS',
        category: 'USER',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'INVESTIGATE_SELF_DEALING',
        autoResolvable: false,
        evaluate: (ctx) => {
            const s = seller(ctx);
            const b = buyer(ctx);
            if (!s?.user || !b?.user || s.user.id === b.user.id) return [];
            const sDevices = new Set(s.sessions.map((x) => x.deviceFingerprintHash));
            const shared = b.sessions.filter((x) => sDevices.has(x.deviceFingerprintHash));
            const sTokens = new Set(s.payoutAccounts.map((a) => a.providerToken));
            const sharedAccounts = b.payoutAccounts.filter((a) => sTokens.has(a.providerToken));
            if (shared.length === 0 && sharedAccounts.length === 0) return [];
            const reasons: RiskReason[] = [];
            if (shared.length) reasons.push({ code: 'SHARED_DEVICE', params: { occurrences: shared.length } });
            if (sharedAccounts.length) reasons.push({ code: 'SHARED_PAYMENT_ACCOUNT', params: { occurrences: sharedAccounts.length } });
            return [{ fingerprint: `${s.user.id}:${b.user.id}`, reasons }];
        }
    },
    /* ----------------------------------------------------------------- transaction */
    {
        id: 'AMOUNT_UNUSUAL',
        category: 'TRANSACTION',
        severity: 'MEDIUM',
        blocksFundsMovement: false,
        recommendedAction: 'ENHANCED_DUE_DILIGENCE',
        autoResolvable: true,
        evaluate: (ctx) => {
            const reasons: RiskReason[] = [];
            const amount = ctx.transaction.amount.amountMinor;
            const threshold = ctx.corridor?.reviewThresholdMinor[ctx.transaction.amount.currency];
            if (threshold && amount > BigInt(threshold)) {
                reasons.push({
                    code: 'ABOVE_CORRIDOR_THRESHOLD',
                    params: { thresholdMinor: threshold, currency: ctx.transaction.amount.currency }
                });
            }
            if (ctx.sellerPastAmountsMinor.length >= 3) {
                const sorted = [...ctx.sellerPastAmountsMinor].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                const median = sorted[Math.floor(sorted.length / 2)]!;
                if (median > 0n && amount > median * 3n) {
                    reasons.push({ code: 'ABOVE_SELLER_HISTORY', params: { factor: 3, medianMinor: median.toString() } });
                }
            }
            return reasons.length ? [{ fingerprint: `${ctx.transaction.id}:${amount}`, reasons }] : [];
        }
    },
    {
        id: 'TRANSACTION_VELOCITY',
        category: 'TRANSACTION',
        severity: 'MEDIUM',
        blocksFundsMovement: false,
        recommendedAction: 'REVIEW_SELLER_ACTIVITY',
        autoResolvable: false,
        evaluate: (ctx) =>
            ctx.sellerTransactionsLast24h >= 3
                ? [
                      {
                          fingerprint: `${ctx.transaction.createdBy}:${ctx.transaction.createdAt.slice(0, 10)}`,
                          reasons: [{ code: 'MANY_TRANSACTIONS_24H', params: { count: ctx.sellerTransactionsLast24h } }]
                      }
                  ]
                : []
    },
    {
        id: 'REPEATED_CONTRACT_AMENDMENTS',
        category: 'TRANSACTION',
        severity: 'MEDIUM',
        blocksFundsMovement: false,
        recommendedAction: 'REVIEW_CONTRACT_HISTORY',
        autoResolvable: false,
        evaluate: (ctx) =>
            ctx.contractVersions.length >= 3
                ? [
                      {
                          fingerprint: `${ctx.transaction.id}:${ctx.contractVersions.length}`,
                          reasons: [{ code: 'CONTRACT_VERSIONS', params: { count: ctx.contractVersions.length } }]
                      }
                  ]
                : []
    },
    {
        id: 'PAYMENT_DETAILS_CHANGED_IN_FLIGHT',
        category: 'TRANSACTION',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'CONFIRM_CHANGE_OUT_OF_BAND',
        autoResolvable: false,
        evaluate: (ctx) => {
            const s = seller(ctx);
            const fundedAt = ctx.transaction.fundedAt;
            if (!fundedAt) return [];
            return activePayout(s)
                .filter((a) => a.createdAt > fundedAt)
                .map((a) => ({
                    fingerprint: a.id,
                    subjectUserId: s?.user?.id,
                    reasons: [{ code: 'PAYOUT_ACCOUNT_ADDED_AFTER_FUNDING', params: { addedAt: a.createdAt } }]
                }));
        }
    },
    {
        id: 'RESTRICTED_PARTY_SCREENING',
        category: 'TRANSACTION',
        severity: 'CRITICAL',
        blocksFundsMovement: true,
        recommendedAction: 'COMPLIANCE_ESCALATION',
        autoResolvable: false,
        evaluate: (ctx) =>
            principals(ctx)
                .filter((p) => p.screening && p.screening.result !== 'NO_MATCH')
                .map((p) => ({
                    fingerprint: p.screening!.id,
                    subjectUserId: p.user?.id,
                    severity: p.screening!.result === 'ERROR' ? ('MEDIUM' as RiskSeverity) : undefined,
                    reasons: [{ code: `SCREENING_${p.screening!.result}`, params: { role: p.party.role, provider: p.screening!.provider } }]
                }))
    },
    {
        id: 'DOCUMENT_AMOUNT_MISMATCH',
        category: 'TRANSACTION',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'REQUEST_CORRECTED_INVOICE',
        autoResolvable: true,
        evaluate: (ctx) =>
            liveDocs(ctx, 'INVOICE')
                .filter(
                    (d) =>
                        d.extracted.amount &&
                        (d.extracted.amount.currency !== ctx.transaction.amount.currency ||
                            BigInt(d.extracted.amount.amountMinor) !== ctx.transaction.amount.amountMinor)
                )
                .map((d) => ({
                    fingerprint: d.id,
                    reasons: [
                        {
                            code: 'INVOICE_VS_CONTRACT',
                            params: {
                                documentAmountMinor: d.extracted.amount!.amountMinor,
                                documentCurrency: d.extracted.amount!.currency,
                                contractAmountMinor: ctx.transaction.amount.amountMinor.toString()
                            }
                        }
                    ]
                }))
    },
    /* ----------------------------------------------------------------- vehicle */
    {
        id: 'VIN_MALFORMED',
        category: 'VEHICLE',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'VERIFY_VIN_PHYSICALLY',
        autoResolvable: true,
        evaluate: (ctx) => {
            if (!ctx.vehicle) return [];
            const r = checkVin(ctx.vehicle.vin);
            return r.structurallyValid
                ? []
                : [{ fingerprint: r.normalized, reasons: [{ code: 'VIN_STRUCTURE', params: { issues: r.issues.join(',') } }] }];
        }
    },
    {
        id: 'VIN_DOCUMENT_MISMATCH',
        category: 'VEHICLE',
        severity: 'CRITICAL',
        blocksFundsMovement: true,
        recommendedAction: 'STOP_AND_INVESTIGATE',
        autoResolvable: true,
        evaluate: (ctx) => {
            if (!ctx.vehicle) return [];
            const expected = normalizeVin(ctx.vehicle.vin);
            return liveDocs(ctx)
                .filter((d) => d.extracted.vin && normalizeVin(d.extracted.vin) !== expected)
                .map((d) => ({
                    fingerprint: d.id,
                    reasons: [
                        { code: 'VIN_DIFFERS', params: { documentType: d.type, documentVin: d.extracted.vin!, declaredVin: expected } }
                    ]
                }));
        }
    },
    {
        id: 'SELLER_NOT_TITLE_HOLDER',
        category: 'VEHICLE',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'REQUEST_PROOF_OF_AUTHORITY',
        autoResolvable: true,
        evaluate: (ctx) => {
            const s = seller(ctx);
            return liveDocs(ctx, 'TITLE')
                .filter((d) => d.extracted.ownerName && !matchesAny(d.extracted.ownerName, sellerNames(s)))
                .map((d) => ({
                    fingerprint: d.id,
                    reasons: [
                        { code: 'TITLE_OWNER_DIFFERS', params: { titleOwner: d.extracted.ownerName!, seller: s?.party.displayName ?? '' } }
                    ]
                }));
        }
    },
    {
        id: 'MISSING_REQUIRED_DOCUMENTS',
        category: 'VEHICLE',
        severity: 'MEDIUM',
        blocksFundsMovement: true,
        recommendedAction: 'REQUEST_DOCUMENTS',
        autoResolvable: true,
        evaluate: (ctx) => {
            if (!ctx.corridor || !POST_AGREEMENT.includes(ctx.transaction.status)) return [];
            const missing = ctx.corridor.requiredDocumentsBeforeFunding.filter((t) => liveDocs(ctx, t).length === 0);
            return missing.length
                ? [
                      {
                          fingerprint: `${ctx.transaction.id}:${missing.join(',')}`,
                          reasons: [{ code: 'DOCUMENTS_MISSING', params: { types: missing.join(',') } }]
                      }
                  ]
                : [];
        }
    },
    {
        id: 'DECLARED_VALUE_INCONSISTENT',
        category: 'VEHICLE',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'RECONCILE_DECLARED_VALUES',
        autoResolvable: true,
        evaluate: (ctx) =>
            liveDocs(ctx, 'EXPORT_DECLARATION')
                .filter(
                    (d) =>
                        d.extracted.amount &&
                        (d.extracted.amount.currency !== ctx.transaction.amount.currency ||
                            BigInt(d.extracted.amount.amountMinor) !== ctx.transaction.amount.amountMinor)
                )
                .map((d) => ({
                    fingerprint: d.id,
                    reasons: [
                        {
                            code: 'EXPORT_VALUE_VS_CONTRACT',
                            params: {
                                declaredMinor: d.extracted.amount!.amountMinor,
                                declaredCurrency: d.extracted.amount!.currency,
                                contractMinor: ctx.transaction.amount.amountMinor.toString()
                            }
                        }
                    ]
                }))
    },
    {
        id: 'EXPORT_PROOF_INCOMPLETE',
        category: 'VEHICLE',
        severity: 'MEDIUM',
        blocksFundsMovement: true,
        recommendedAction: 'REQUEST_EXPORT_DECLARATION',
        autoResolvable: true,
        evaluate: (ctx) =>
            liveDocs(ctx, 'BILL_OF_LADING').length > 0 && liveDocs(ctx, 'EXPORT_DECLARATION').length === 0
                ? [{ fingerprint: `${ctx.transaction.id}:export`, reasons: [{ code: 'BOL_WITHOUT_EXPORT_DECLARATION', params: {} }] }]
                : []
    },
    {
        id: 'SHIPPING_DOCUMENT_INCONSISTENT',
        category: 'VEHICLE',
        severity: 'HIGH',
        blocksFundsMovement: true,
        recommendedAction: 'CONTACT_CARRIER',
        autoResolvable: true,
        evaluate: (ctx) => {
            const b = buyer(ctx);
            return liveDocs(ctx, 'BILL_OF_LADING').flatMap((d) => {
                const reasons: RiskReason[] = [];
                if (
                    d.extracted.consignee &&
                    !matchesAny(d.extracted.consignee, [b?.user?.fullName, b?.organization?.legalName, b?.party.displayName])
                ) {
                    reasons.push({
                        code: 'CONSIGNEE_NOT_BUYER',
                        params: { consignee: d.extracted.consignee, buyer: b?.party.displayName ?? '' }
                    });
                }
                const ports = ctx.corridor?.expectedDischargePorts ?? [];
                if (d.extracted.portOfDischarge && ports.length && !ports.some((p) => namesMatch(p, d.extracted.portOfDischarge))) {
                    reasons.push({
                        code: 'UNEXPECTED_DISCHARGE_PORT',
                        params: { port: d.extracted.portOfDischarge, expected: ports.join(', ') }
                    });
                }
                return reasons.length ? [{ fingerprint: `${d.id}:${reasons.map((r) => r.code).join(',')}`, reasons }] : [];
            });
        }
    }
];

export function evaluateRisk(ctx: RiskContext, rules: RiskRule[] = RULES): RiskAlertDraft[] {
    return rules.flatMap((rule) =>
        rule.evaluate(ctx).map((f) => ({
            ...f,
            fingerprint: `${rule.id}:${f.fingerprint}`,
            ruleId: rule.id,
            category: rule.category,
            severity: f.severity ?? rule.severity,
            blocksFundsMovement: rule.blocksFundsMovement && (f.severity ?? rule.severity) !== 'LOW',
            recommendedAction: rule.recommendedAction,
            autoResolvable: rule.autoResolvable
        }))
    );
}

export const SEVERITY_ORDER: Record<RiskSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
