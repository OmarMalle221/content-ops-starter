/** Serializable view models passed from server components to client components. */
import type { MoneyDTO } from '@/domain/money';
import type {
    ContractTerms,
    DisputeOutcome,
    DisputeReason,
    DisputeStatus,
    DocumentStatus,
    DocumentType,
    ExtractedReferences,
    MilestoneStatus,
    PartyRole,
    PayoutStatus,
    RefundStatus,
    RiskReason,
    RiskSeverity,
    TransactionStatus,
    Vehicle,
    VerificationStatus
} from '@/domain/model';
import type { ComparisonRow } from '@/domain/documents';

export interface TransactionPermissions {
    sendInvitations: boolean;
    regenerateInvitation: boolean;
    decideContract: boolean;
    amendContract: boolean;
    requestFunding: boolean;
    uploadDocuments: boolean;
    uploadableTypes: DocumentType[];
    submitMilestone: boolean;
    reviewMilestone: boolean;
    openDispute: boolean;
    cancel: boolean;
    viewPayments: boolean;
    viewRisk: boolean;
    simulatePartner: boolean;
}

export interface TransactionView {
    id: string;
    reference: string;
    title: string;
    status: TransactionStatus;
    amount: MoneyDTO;
    corridorCode: string;
    createdAt: string;
    updatedAt: string;
    fundedAt?: string;
    closedAt?: string;
    cancellationReason?: string;
    isDemo: boolean;
    viewer: { userId: string; partyRole?: PartyRole; staff: boolean; viaOrganization: boolean; kycStatus: VerificationStatus };
    can: TransactionPermissions;
    blockedReasons: string[];
    underReview: boolean;
    parties: {
        id: string;
        role: PartyRole;
        displayName: string;
        email: string;
        status: string;
        kycStatus?: VerificationStatus;
        joinedAt?: string;
        isMe: boolean;
    }[];
    vehicle?: Omit<Vehicle, 'transactionId'> & { vinStructurallyValid: boolean; vinCheckDigitEvaluated: boolean };
    contract?: {
        currentVersionId: string;
        versionNumber: number;
        contentHash: string;
        status: string;
        terms: ContractTerms;
        changedFields: string[];
        changeSummary?: string;
        createdAt: string;
        acceptances: { partyId: string; role: PartyRole; decision: 'ACCEPTED' | 'DECLINED'; decidedAt: string; comment?: string }[];
        history: { id: string; versionNumber: number; status: string; createdAt: string; changeSummary?: string; contentHash: string }[];
    };
    milestones: {
        id: string;
        sequence: number;
        title: string;
        description: string;
        shareBps: number;
        amount: MoneyDTO;
        status: MilestoneStatus;
        requiredEvidence: DocumentType[];
        evidence: { documentId: string; type: DocumentType; title: string; status: DocumentStatus }[];
        missingEvidence: DocumentType[];
        submittedAt?: string;
        submissionNote?: string;
        changeRequestReason?: string;
        payout?: { status: PayoutStatus; amount: MoneyDTO; failureReason?: string };
    }[];
    documents: {
        id: string;
        logicalId: string;
        version: number;
        type: DocumentType;
        title: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        sha256: string;
        status: DocumentStatus;
        uploadedAt: string;
        uploadedBy: string;
        extracted: ExtractedReferences;
        extractionSource: string;
        scanStatus: string;
        canOpen: boolean;
        isMine: boolean;
    }[];
    comparison?: ComparisonRow[];
    payment?: {
        instruction?: {
            id: string;
            providerReference: string;
            status: string;
            amount: MoneyDTO;
            details: { beneficiaryName: string; bankName: string; accountMasked: string; paymentReference: string; notes: string };
            expiresAt: string;
        };
        heldMinor: string;
        payouts: {
            id: string;
            status: PayoutStatus;
            amount: MoneyDTO;
            providerReference?: string;
            requestedAt: string;
            failureReason?: string;
            attempts: number;
            milestoneTitle?: string;
        }[];
        refunds: {
            id: string;
            status: RefundStatus;
            amount: MoneyDTO;
            providerReference?: string;
            requestedAt: string;
            failureReason?: string;
        }[];
        providerSimulated: boolean;
    };
    disputes: {
        id: string;
        reason: DisputeReason;
        status: DisputeStatus;
        description: string;
        requestedOutcome: string;
        openedByRole: 'BUYER' | 'SELLER';
        openedByMe: boolean;
        responseDueAt: string;
        createdAt: string;
        messages: { id: string; authorRole: string; body: string; createdAt: string; mine: boolean; documentIds: string[] }[];
        decision?: {
            outcome: DisputeOutcome;
            sellerAmount: MoneyDTO;
            buyerRefundAmount: MoneyDTO;
            rationale: string;
            contractClause: string;
            createdAt: string;
        };
    }[];
    risk?: {
        id: string;
        ruleId: string;
        severity: RiskSeverity;
        status: string;
        reasons: RiskReason[];
        recommendedAction: string;
        blocksFundsMovement: boolean;
        createdAt: string;
    }[];
    holds?: { id: string; type: string; status: string; reference: string; placedAt: string }[];
    timeline: { id: string; at: string; action: string; actor: string; metadata: Record<string, unknown> }[];
    simulator?: { instructionReference?: string; transfers: { reference: string; kind: 'PAYOUT' | 'REFUND'; status: string }[] };
}
