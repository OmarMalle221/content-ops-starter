/**
 * Core domain model. These types are persistence-agnostic: the in-memory adapter stores them
 * as-is and the Supabase schema (supabase/migrations) maps them to normalized tables.
 */
import type { CurrencyCode, Money, MoneyDTO } from './money';

export type Id = string;
export type ISODateTime = string;
export type CountryCode = string; // ISO 3166-1 alpha-2
export type Locale = 'fr' | 'en';

/* ------------------------------------------------------------------ identity & organizations */

export const PLATFORM_ROLES = [
    'compliance_analyst',
    'document_reviewer',
    'dispute_manager',
    'finance_operator',
    'platform_admin',
    'auditor'
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type VerificationStatus = 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export interface User {
    id: Id;
    email: string;
    fullName: string;
    phone?: string;
    country: CountryCode;
    city?: string;
    locale: Locale;
    platformRoles: PlatformRole[];
    kycStatus: VerificationStatus;
    status: 'ACTIVE' | 'SUSPENDED';
    /** TOTP secret reference. In demo mode the secret is a fixed fictitious value; in production MFA is delegated to Supabase Auth. */
    mfaTotpSecret?: string;
    createdAt: ISODateTime;
    isDemo: boolean;
}

export type OrganizationType = 'DEALER' | 'EXPORTER' | 'FREIGHT_FORWARDER' | 'INSPECTION_COMPANY' | 'BUYER_BUSINESS';

export interface Organization {
    id: Id;
    legalName: string;
    tradeName?: string;
    registrationNumber: string;
    country: CountryCode;
    city?: string;
    type: OrganizationType;
    kybStatus: VerificationStatus;
    createdAt: ISODateTime;
}

export type OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface OrganizationMember {
    id: Id;
    organizationId: Id;
    userId: Id;
    role: OrganizationRole;
    createdAt: ISODateTime;
}

export type IdentityDocumentType = 'PASSPORT' | 'NATIONAL_ID' | 'DRIVER_LICENSE' | 'BUSINESS_REGISTRY';
export type CheckResult = 'PASS' | 'FAIL' | 'REVIEW';

export interface IdentityVerification {
    id: Id;
    subjectType: 'USER' | 'ORGANIZATION';
    subjectId: Id;
    provider: string;
    providerReference: string;
    status: VerificationStatus;
    level: 'BASIC' | 'ENHANCED';
    verifiedName?: string;
    documentType?: IdentityDocumentType;
    documentCountry?: CountryCode;
    documentExpiresAt?: string; // YYYY-MM-DD
    checks: { code: string; result: CheckResult }[];
    reviewedBy?: Id;
    reviewNote?: string;
    simulated: boolean;
    createdAt: ISODateTime;
    completedAt?: ISODateTime;
}

export interface BeneficialOwner {
    id: Id;
    organizationId: Id;
    fullName: string;
    ownershipBps: number;
    country: CountryCode;
    verificationStatus: VerificationStatus;
    createdAt: ISODateTime;
}

export interface PaymentAccount {
    id: Id;
    ownerType: 'USER' | 'ORGANIZATION';
    ownerId: Id;
    holderName: string;
    currency: CurrencyCode;
    country: CountryCode;
    bankName: string;
    /** Display-only masked identifier. Full account numbers are never stored by TrustCargo. */
    maskedIdentifier: string;
    /** Opaque token issued by the payment partner's vault. */
    providerToken: string;
    status: 'PENDING_VERIFICATION' | 'VERIFIED' | 'DISABLED';
    createdAt: ISODateTime;
    verifiedAt?: ISODateTime;
    disabledAt?: ISODateTime;
    replacesAccountId?: Id;
}

export interface SessionEvent {
    id: Id;
    userId: Id;
    at: ISODateTime;
    country: CountryCode;
    deviceFingerprintHash: string;
    ipHash: string;
}

/* ------------------------------------------------------------------ transactions */

export const TRANSACTION_STATUSES = [
    'DRAFT',
    'AWAITING_PARTIES',
    'IDENTITY_VERIFICATION',
    'AWAITING_AGREEMENT',
    'AWAITING_FUNDING',
    'FUNDING_PENDING',
    'FUNDS_CONFIRMED',
    'IN_PROGRESS',
    'MILESTONE_REVIEW',
    'DISPUTED',
    'COMPLETED',
    'CANCELLED',
    'REFUND_PENDING',
    'REFUNDED'
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** Generic engine, specialised modules. Only VEHICLE_PURCHASE is enabled in the MVP. */
export type TransactionType = 'VEHICLE_PURCHASE' | 'GOODS_PURCHASE' | 'SERVICE_MILESTONES';

export interface Transaction {
    id: Id;
    reference: string;
    type: TransactionType;
    status: TransactionStatus;
    title: string;
    amount: Money;
    corridorId: Id;
    sellerOrganizationId?: Id;
    createdBy: Id;
    currentContractVersionId?: Id;
    /** Optimistic concurrency token, incremented on every write. */
    version: number;
    createdAt: ISODateTime;
    updatedAt: ISODateTime;
    fundedAt?: ISODateTime;
    closedAt?: ISODateTime;
    cancellationReason?: string;
    /** Status before entering DISPUTED, so a RESUME decision can restore it. */
    statusBeforeDispute?: TransactionStatus;
    isDemo: boolean;
}

export type PartyRole = 'SELLER' | 'BUYER' | 'INSPECTOR' | 'FREIGHT_FORWARDER';

export interface TransactionParty {
    id: Id;
    transactionId: Id;
    role: PartyRole;
    userId?: Id;
    organizationId?: Id;
    displayName: string;
    email: string;
    status: 'INVITED' | 'JOINED' | 'DECLINED' | 'REMOVED';
    /** SHA-256 of the invitation token; the raw token is only ever shown once to the inviter. */
    invitationTokenHash?: string;
    invitationExpiresAt?: ISODateTime;
    joinedAt?: ISODateTime;
    createdAt: ISODateTime;
}

export interface Vehicle {
    id: Id;
    transactionId: Id;
    make: string;
    model: string;
    year: number;
    vin: string;
    mileageKm: number;
    declaredCondition: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'NEEDS_REPAIR';
    conditionNotes?: string;
    originCountry: CountryCode;
    destinationCountry: CountryCode;
    exteriorColor?: string;
}

export const DOCUMENT_TYPES = [
    'INVOICE',
    'TITLE',
    'CONTRACT',
    'INSPECTION_REPORT',
    'PHOTO',
    'BILL_OF_LADING',
    'EXPORT_DECLARATION',
    'DELIVERY_PROOF',
    'IDENTITY',
    'OTHER'
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export interface MilestoneTerm {
    key: string;
    title: string;
    description: string;
    shareBps: number;
    requiredEvidence: DocumentType[];
}

export interface ContractTerms {
    goodsDescription: string;
    totalAmount: MoneyDTO;
    sellerResponsibilities: string;
    buyerResponsibilities: string;
    inspectionTerms: string;
    shippingTerms: string;
    deliveryTerms: string;
    releaseTerms: string;
    refundTerms: string;
    disputeProcedure: string;
    deadlines: { inspectionDays: number; shippingDays: number; deliveryDays: number; reviewDays: number };
    milestones: MilestoneTerm[];
}

export interface Contract {
    id: Id;
    transactionId: Id;
    createdAt: ISODateTime;
}

export interface ContractVersion {
    id: Id;
    contractId: Id;
    transactionId: Id;
    versionNumber: number;
    terms: ContractTerms;
    /** SHA-256 over the canonical JSON of `terms`. Acceptances bind to this hash. */
    contentHash: string;
    status: 'PROPOSED' | 'ACCEPTED' | 'SUPERSEDED';
    changeSummary?: string;
    createdBy: Id;
    createdAt: ISODateTime;
}

export interface ContractAcceptance {
    id: Id;
    transactionId: Id;
    contractVersionId: Id;
    partyId: Id;
    userId: Id;
    decision: 'ACCEPTED' | 'DECLINED';
    contentHash: string;
    comment?: string;
    decidedAt: ISODateTime;
}

export type MilestoneStatus = 'PENDING' | 'ACTIVE' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'RELEASED' | 'REFUNDED' | 'CANCELLED';

export interface Milestone {
    id: Id;
    transactionId: Id;
    contractVersionId: Id;
    sequence: number;
    key: string;
    title: string;
    description: string;
    shareBps: number;
    amount: Money;
    requiredEvidence: DocumentType[];
    status: MilestoneStatus;
    submittedAt?: ISODateTime;
    submissionNote?: string;
    decidedAt?: ISODateTime;
    decidedBy?: Id;
    changeRequestReason?: string;
}

export interface MilestoneEvidence {
    id: Id;
    milestoneId: Id;
    transactionId: Id;
    documentId: Id;
    addedBy: Id;
    addedAt: ISODateTime;
}

/* ------------------------------------------------------------------ documents */

export type DocumentStatus = 'SCAN_PENDING' | 'QUARANTINED' | 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED' | 'SUPERSEDED';

export interface ExtractedReferences {
    vin?: string;
    ownerName?: string;
    amount?: MoneyDTO;
    consignee?: string;
    shipper?: string;
    portOfLoading?: string;
    portOfDischarge?: string;
    documentNumber?: string;
    issueDate?: string;
}

export interface Document {
    id: Id;
    /** All versions of the same logical document share this id. */
    logicalId: Id;
    version: number;
    transactionId?: Id;
    ownerUserId: Id;
    type: DocumentType;
    title: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
    status: DocumentStatus;
    /** Which party roles may see the document, besides compliance staff. */
    visibleToRoles: PartyRole[];
    extracted: ExtractedReferences;
    /** DECLARED = typed by the uploader; MOCK_EXTRACTION = simulated OCR. Neither proves authenticity. */
    extractionSource: 'DECLARED' | 'MOCK_EXTRACTION' | 'NONE';
    scan: { status: 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR'; engine: string; scannedAt?: ISODateTime };
    uploadedAt: ISODateTime;
}

export interface DocumentVerification {
    id: Id;
    documentId: Id;
    reviewerId: Id;
    decision: 'VERIFIED' | 'REJECTED' | 'NEEDS_INFO';
    notes: string;
    createdAt: ISODateTime;
}

export interface DocumentAccessLog {
    id: Id;
    documentId: Id;
    userId: Id;
    action: 'VIEW_METADATA' | 'SIGNED_URL_ISSUED' | 'DOWNLOAD' | 'DENIED';
    at: ISODateTime;
}

/* ------------------------------------------------------------------ risk */

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RiskCategory = 'USER' | 'TRANSACTION' | 'VEHICLE';

export interface RiskReason {
    code: string;
    params: Record<string, string | number>;
}

export interface RiskAlert {
    id: Id;
    ruleId: string;
    category: RiskCategory;
    severity: RiskSeverity;
    transactionId?: Id;
    subjectUserId?: Id;
    /** Stable identity of the finding, used for de-duplication across re-evaluations. */
    fingerprint: string;
    reasons: RiskReason[];
    recommendedAction: string;
    blocksFundsMovement: boolean;
    status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED';
    createdAt: ISODateTime;
    updatedAt: ISODateTime;
}

export interface RiskReview {
    id: Id;
    alertId: Id;
    reviewerId: Id;
    decision: 'CONFIRMED_RISK' | 'RISK_MITIGATED' | 'FALSE_POSITIVE' | 'NEEDS_INFORMATION' | 'ESCALATED';
    notes: string;
    createdAt: ISODateTime;
}

export interface ScreeningResult {
    id: Id;
    subjectType: 'USER' | 'ORGANIZATION';
    subjectId: Id;
    provider: string;
    providerReference: string;
    result: 'NO_MATCH' | 'POTENTIAL_MATCH' | 'CONFIRMED_MATCH' | 'ERROR';
    listsChecked: string[];
    simulated: boolean;
    checkedAt: ISODateTime;
}

/* ------------------------------------------------------------------ disputes & compliance holds */

export const DISPUTE_REASONS = [
    'NOT_AS_DESCRIBED',
    'NOT_DELIVERED',
    'SUSPICIOUS_DOCUMENTS',
    'CONTRACTUAL_DELAY',
    'INSPECTION_DISAGREEMENT',
    'POTENTIAL_FRAUD'
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export type DisputeStatus = 'AWAITING_RESPONSE' | 'UNDER_REVIEW' | 'DECIDED' | 'EXECUTING' | 'RESOLVED' | 'WITHDRAWN' | 'ARCHIVED';

export interface Dispute {
    id: Id;
    transactionId: Id;
    milestoneId?: Id;
    openedBy: Id;
    openedByRole: 'BUYER' | 'SELLER';
    reason: DisputeReason;
    description: string;
    requestedOutcome: string;
    status: DisputeStatus;
    responseDueAt: ISODateTime;
    assignedTo?: Id;
    createdAt: ISODateTime;
    updatedAt: ISODateTime;
    resolvedAt?: ISODateTime;
}

export interface DisputeMessage {
    id: Id;
    disputeId: Id;
    authorId: Id;
    authorRole: 'BUYER' | 'SELLER' | 'PLATFORM';
    body: string;
    documentIds: Id[];
    createdAt: ISODateTime;
}

export type DisputeOutcome = 'RELEASE_TO_SELLER' | 'REFUND_TO_BUYER' | 'SPLIT' | 'RESUME';

export interface DisputeDecision {
    id: Id;
    disputeId: Id;
    transactionId: Id;
    decidedBy: Id;
    outcome: DisputeOutcome;
    sellerAmount: Money;
    buyerRefundAmount: Money;
    rationale: string;
    contractClause: string;
    mfaVerifiedAt: ISODateTime;
    createdAt: ISODateTime;
}

/** Regulatory / legal freezes. Deliberately separate from commercial disputes. */
export interface ComplianceHold {
    id: Id;
    transactionId: Id;
    type: 'SANCTIONS_REVIEW' | 'COURT_ORDER' | 'REGULATORY_FREEZE' | 'LAW_ENFORCEMENT_REQUEST';
    status: 'ACTIVE' | 'LIFTED';
    reference: string;
    notes: string;
    placedBy: Id;
    placedAt: ISODateTime;
    liftedBy?: Id;
    liftedAt?: ISODateTime;
}

/* ------------------------------------------------------------------ payments */

export interface PaymentInstruction {
    id: Id;
    transactionId: Id;
    provider: string;
    providerReference: string;
    amount: Money;
    payerUserId: Id;
    status: 'CREATED' | 'PENDING' | 'FUNDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
    details: {
        method: 'BANK_TRANSFER';
        beneficiaryName: string;
        bankName: string;
        accountMasked: string;
        paymentReference: string;
        notes: string;
    };
    idempotencyKey: string;
    expiresAt: ISODateTime;
    createdAt: ISODateTime;
    updatedAt: ISODateTime;
    failureReason?: string;
}

export type PayoutStatus = 'REQUESTED' | 'SUBMITTED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
export type RefundStatus = 'REQUESTED' | 'SUBMITTED' | 'PROCESSING' | 'REFUNDED' | 'FAILED' | 'CANCELLED';

export interface Payout {
    id: Id;
    transactionId: Id;
    milestoneId?: Id;
    disputeDecisionId?: Id;
    payeePartyId: Id;
    paymentAccountId: Id;
    amount: Money;
    status: PayoutStatus;
    provider: string;
    providerReference?: string;
    idempotencyKey: string;
    requestedBy: Id;
    requestedAt: ISODateTime;
    updatedAt: ISODateTime;
    /** Number of submission attempts to the partner (retry policy). */
    attempts: number;
    failureReason?: string;
}

export interface Refund {
    id: Id;
    transactionId: Id;
    disputeDecisionId?: Id;
    payerPartyId: Id;
    amount: Money;
    status: RefundStatus;
    provider: string;
    providerReference?: string;
    idempotencyKey: string;
    requestedBy: Id;
    requestedAt: ISODateTime;
    updatedAt: ISODateTime;
    /** Number of submission attempts to the partner (retry policy). */
    attempts: number;
    failureReason?: string;
}

export type ProviderEventType =
    | 'payment.initiated'
    | 'payment.pending'
    | 'funds.confirmed'
    | 'payment.failed'
    | 'payout.authorized'
    | 'payout.paid'
    | 'payout.failed'
    | 'refund.processing'
    | 'refund.completed'
    | 'refund.failed'
    | 'provider.error';

export interface ProviderEvent {
    id: Id;
    provider: string;
    externalEventId: string;
    type: ProviderEventType;
    payload: Record<string, unknown>;
    signatureVerified: boolean;
    status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
    error?: string;
    transactionId?: Id;
    occurredAt: ISODateTime;
    receivedAt: ISODateTime;
    processedAt?: ISODateTime;
}

export interface ProviderConnection {
    id: Id;
    provider: string;
    displayName: string;
    environment: 'SIMULATION' | 'SANDBOX' | 'PRODUCTION';
    status: 'ACTIVE' | 'DISABLED';
    capabilities: string[];
    /** Name of the secret in the secret manager — never the secret itself. */
    webhookSecretRef: string;
    regulatoryStatusNote: string;
    createdAt: ISODateTime;
}

/* ------------------------------------------------------------------ ledger */

export type LedgerAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export interface LedgerAccount {
    id: Id;
    code: string;
    name: string;
    type: LedgerAccountType;
    currency: CurrencyCode;
    transactionId?: Id;
    createdAt: ISODateTime;
}

export type LedgerJournalKind =
    'FUNDS_REPORTED_RECEIVED' | 'RELEASE_AUTHORIZED' | 'PAYOUT_SETTLED' | 'REFUND_AUTHORIZED' | 'REFUND_SETTLED' | 'REVERSAL';

export interface LedgerJournal {
    id: Id;
    idempotencyKey: string;
    kind: LedgerJournalKind;
    transactionId?: Id;
    externalReference?: string;
    providerEventId?: Id;
    description: string;
    reversesJournalId?: Id;
    postedBy: string;
    postedAt: ISODateTime;
}

export interface LedgerEntry {
    id: Id;
    journalId: Id;
    accountId: Id;
    direction: 'DEBIT' | 'CREDIT';
    amountMinor: bigint;
    currency: CurrencyCode;
}

export interface ReconciliationItem {
    externalReference: string;
    kind: string;
    providerAmountMinor?: string;
    ledgerAmountMinor?: string;
    currency: CurrencyCode;
    result: 'MATCHED' | 'MISSING_IN_LEDGER' | 'MISSING_AT_PROVIDER' | 'AMOUNT_MISMATCH';
}

export interface Reconciliation {
    id: Id;
    provider: string;
    runBy: Id;
    runAt: ISODateTime;
    status: 'MATCHED' | 'DISCREPANCIES';
    items: ReconciliationItem[];
}

/* ------------------------------------------------------------------ audit, notifications, config */

export interface AuditEvent {
    id: Id;
    sequence: number;
    at: ISODateTime;
    actorType: 'USER' | 'SYSTEM' | 'PROVIDER';
    actorId?: Id;
    action: string;
    entityType: string;
    entityId: Id;
    transactionId?: Id;
    metadata: Record<string, unknown>;
    /** Tamper-evidence: SHA-256(previousHash + canonical event). */
    previousHash: string;
    hash: string;
}

export interface Notification {
    id: Id;
    userId: Id;
    type: string;
    params: Record<string, string>;
    transactionId?: Id;
    readAt?: ISODateTime;
    createdAt: ISODateTime;
}

export interface Corridor {
    id: Id;
    code: string;
    originCountry: CountryCode;
    destinationCountry: CountryCode;
    enabled: boolean;
    allowedCurrencies: CurrencyCode[];
    /** Above this amount (per currency, minor units as string), an enhanced-review alert is raised. */
    reviewThresholdMinor: Partial<Record<CurrencyCode, string>>;
    /** Destination ports expected on shipping documents. */
    expectedDischargePorts: string[];
    requiredDocumentsBeforeFunding: DocumentType[];
    updatedAt: ISODateTime;
    updatedBy?: Id;
}

export interface SecuritySettings {
    adminMfaMaxAgeMinutes: number;
    sensitiveActionMfaMaxAgeMinutes: number;
    payoutAccountCoolingOffHours: number;
    invitationTtlHours: number;
    signedUrlTtlSeconds: number;
    maxUploadBytes: number;
    updatedAt: ISODateTime;
    updatedBy?: Id;
}
