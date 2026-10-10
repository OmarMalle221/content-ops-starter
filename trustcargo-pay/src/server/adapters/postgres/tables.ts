/**
 * Declarative mapping of the domain model (src/domain/model.ts) to the Supabase schema
 * (supabase/migrations): one spec per table, field → column(s) + codec. `spec<T>` requires every
 * property of the entity to be mapped, so adding a field to the model without a column fails to compile.
 */
import type * as M from '@/domain/model';
import { DOCUMENT_TYPES, TRANSACTION_STATUSES } from '@/domain/model';
import type { Db } from '@/server/ports/db';
import { storableValue } from '@/server/text';
import {
    INTEGER_STRING_RE,
    InvalidValueError,
    col,
    money,
    nested,
    polymorphicId,
    singletonId,
    types,
    withDerived,
    type FieldCodec,
    type Query
} from './codecs';
import { PgMutableTable, PgTable, type TableSpec } from './pg-table';

type Factory = (key: string) => FieldCodec;
type Column = (column: string) => Factory;

const column =
    (type: Parameters<typeof col>[1]): Column =>
    (name) =>
    (key) =>
        col(name, type, key);

const text = column(types.text);
const uuid = column(types.uuid);
const int = column(types.int);
const bool = column(types.bool);
const bigint = column(types.bigint);
const bigintAsNumber = column(types.bigintAsNumber);
const timestamp = column(types.timestamptz);
const date = column(types.date);
const json = column(types.json);
const textArray = column(types.textArray);
const enumOf = (values: readonly string[]) => column(types.enumOf(values));
const enumArray = (sqlType: string) => column(types.enumArray(sqlType));
const amount =
    (amountColumn: string, currencyColumn: string): Factory =>
    (key) =>
        money(amountColumn, currencyColumn, key);
const subjectOrOwner =
    (discriminatorKey: string, discriminatorColumn: string, prefix: 'subject' | 'owner'): Factory =>
    (key) =>
        polymorphicId(discriminatorKey, discriminatorColumn, { USER: `${prefix}_user_id`, ORGANIZATION: `${prefix}_organization_id` }, key);

const VERIFICATION_STATUSES = [
    'NOT_STARTED',
    'PENDING',
    'VERIFIED',
    'REJECTED',
    'EXPIRED'
] as const satisfies readonly M.VerificationStatus[];
const PARTY_ROLES = ['SELLER', 'BUYER', 'INSPECTOR', 'FREIGHT_FORWARDER'] as const satisfies readonly M.PartyRole[];
const verificationStatus = enumOf(VERIFICATION_STATUSES);

/* ------------------------------------------------------------------ fields stored in other tables */

/** User.platformRoles ↔ trustcargo.user_platform_roles (ordinal keeps the written order). */
const platformRoles: Factory = (key) => ({
    select: () => [
        `coalesce((select array_agg(r.role::text order by r.ordinal, r.role) from trustcargo.user_platform_roles r where r.user_id = t.id), '{}'::text[]) as "${key}"`
    ],
    decode: (row) => row[key],
    assign: () => [],
    equals: () => null,
    writeRelated: async (query, id, value, mode) => {
        const roles = types.textArray.encode(value ?? [], key) as string[];
        if (mode === 'update') await query('delete from trustcargo.user_platform_roles where user_id = $1', [id]);
        if (!roles.length) return;
        await query(
            `insert into trustcargo.user_platform_roles (user_id, role, ordinal)
             select $1, r.role::trustcargo.platform_role, (r.ordinal - 1)::smallint
             from unnest($2::text[]) with ordinality as r (role, ordinal)`,
            [id, roles]
        );
    }
});

/** User.mfaTotpSecret (demo personas only) ↔ trustcargo_private.demo_mfa_secrets (service_role only). */
const demoTotpSecret: Factory = (key) => {
    const secret = '(select s.totp_secret from trustcargo_private.demo_mfa_secrets s where s.user_id = t.id)';
    return {
        select: () => [`${secret} as "${key}"`],
        decode: (row) => row[key] ?? undefined,
        assign: () => [],
        equals: (value, params) => {
            const v = types.text.filter(value); // the stored form, or NO_MATCH (same rule as every text column)
            return typeof v === 'string' ? `${secret} = ${params.add(v)}::text` : null;
        },
        writeRelated: async (query, id, value, mode) => {
            if (mode === 'update') await query('delete from trustcargo_private.demo_mfa_secrets where user_id = $1', [id]);
            if (value === undefined) return;
            await query('insert into trustcargo_private.demo_mfa_secrets (user_id, totp_secret) values ($1, $2)', [
                id,
                types.text.encode(value, key)
            ]);
        }
    };
};

const RECONCILIATION_ITEM_KEYS = new Set(['externalReference', 'kind', 'providerAmountMinor', 'ledgerAmountMinor', 'currency', 'result']);

/** Reconciliation.items ↔ trustcargo.reconciliation_items (ordinal keeps the order; amounts as bigint). */
const reconciliationItems: Factory = (key) => ({
    select: () => [
        `coalesce((select json_agg(json_strip_nulls(json_build_object(
            'externalReference', i.external_reference, 'kind', i.kind,
            'providerAmountMinor', i.provider_amount_minor::text, 'ledgerAmountMinor', i.ledger_amount_minor::text,
            'currency', i.currency, 'result', i.result)) order by i.ordinal)
          from trustcargo.reconciliation_items i where i.reconciliation_id = t.id), '[]'::json) as "${key}"`
    ],
    decode: (row) => row[key],
    assign: () => [],
    equals: () => null,
    writeRelated: async (query, id, value) => {
        if (!Array.isArray(value)) throw new InvalidValueError(key, 'an array of items');
        for (const item of value as Record<string, unknown>[]) {
            const lossless =
                typeof item === 'object' &&
                item !== null &&
                Object.keys(item).every((k) => RECONCILIATION_ITEM_KEYS.has(k)) &&
                [item.externalReference, item.kind, item.currency, item.result].every((v) => typeof v === 'string') &&
                [item.providerAmountMinor, item.ledgerAmountMinor].every(
                    (v) => v === undefined || (typeof v === 'string' && INTEGER_STRING_RE.test(v))
                );
            if (!lossless) throw new InvalidValueError(key, 'ReconciliationItem objects with integer-string amounts');
        }
        if (!value.length) return;
        await query(
            `insert into trustcargo.reconciliation_items
                 (reconciliation_id, ordinal, external_reference, kind, provider_amount_minor, ledger_amount_minor, currency, result)
             select $1, (e.ordinal - 1)::int, e.item ->> 'externalReference', e.item ->> 'kind',
                    (e.item ->> 'providerAmountMinor')::bigint, (e.item ->> 'ledgerAmountMinor')::bigint,
                    e.item ->> 'currency', e.item ->> 'result'
             from jsonb_array_elements($2::jsonb) with ordinality as e (item, ordinal)`,
            [id, JSON.stringify(storableValue(value, key))]
        );
    }
});

/* ------------------------------------------------------------------ table specs */

function spec<T extends { id: string }>(
    name: keyof Db,
    table: string,
    fields: { [K in keyof Required<T>]: Factory },
    options: Pick<TableSpec, 'appendOnly' | 'versioned' | 'upsert'> = {}
): TableSpec {
    return {
        name,
        table,
        fields: Object.fromEntries(Object.entries<Factory>(fields).map(([key, make]) => [key, make(key)])),
        ...options
    };
}

export const TABLES = {
    users: spec<M.User>('users', 'trustcargo.users', {
        id: uuid('id'),
        email: text('email'),
        fullName: text('full_name'),
        phone: text('phone'),
        country: text('country'),
        city: text('city'),
        locale: text('locale'),
        platformRoles,
        kycStatus: verificationStatus('kyc_status'),
        status: text('status'),
        mfaTotpSecret: demoTotpSecret,
        createdAt: timestamp('created_at'),
        isDemo: bool('is_demo')
    }),
    organizations: spec<M.Organization>('organizations', 'trustcargo.organizations', {
        id: uuid('id'),
        legalName: text('legal_name'),
        tradeName: text('trade_name'),
        registrationNumber: text('registration_number'),
        country: text('country'),
        city: text('city'),
        type: text('type'),
        kybStatus: verificationStatus('kyb_status'),
        createdAt: timestamp('created_at')
    }),
    organizationMembers: spec<M.OrganizationMember>('organizationMembers', 'trustcargo.organization_members', {
        id: uuid('id'),
        organizationId: uuid('organization_id'),
        userId: uuid('user_id'),
        role: text('role'),
        createdAt: timestamp('created_at')
    }),
    identityVerifications: spec<M.IdentityVerification>('identityVerifications', 'trustcargo.identity_verifications', {
        id: uuid('id'),
        subjectType: text('subject_type'),
        subjectId: subjectOrOwner('subjectType', 'subject_type', 'subject'),
        provider: text('provider'),
        providerReference: text('provider_reference'),
        status: verificationStatus('status'),
        level: text('level'),
        verifiedName: text('verified_name'),
        documentType: text('document_type'),
        documentCountry: text('document_country'),
        documentExpiresAt: date('document_expires_at'),
        checks: json('checks'),
        reviewedBy: uuid('reviewed_by'),
        reviewNote: text('review_note'),
        simulated: bool('simulated'),
        createdAt: timestamp('created_at'),
        completedAt: timestamp('completed_at')
    }),
    beneficialOwners: spec<M.BeneficialOwner>('beneficialOwners', 'trustcargo.beneficial_owners', {
        id: uuid('id'),
        organizationId: uuid('organization_id'),
        fullName: text('full_name'),
        ownershipBps: int('ownership_bps'),
        country: text('country'),
        verificationStatus: verificationStatus('verification_status'),
        createdAt: timestamp('created_at')
    }),
    paymentAccounts: spec<M.PaymentAccount>('paymentAccounts', 'trustcargo.payment_accounts', {
        id: uuid('id'),
        ownerType: text('owner_type'),
        ownerId: subjectOrOwner('ownerType', 'owner_type', 'owner'),
        holderName: text('holder_name'),
        currency: text('currency'),
        country: text('country'),
        bankName: text('bank_name'),
        maskedIdentifier: text('masked_identifier'),
        providerToken: text('provider_token'),
        status: text('status'),
        createdAt: timestamp('created_at'),
        verifiedAt: timestamp('verified_at'),
        disabledAt: timestamp('disabled_at'),
        replacesAccountId: uuid('replaces_account_id')
    }),
    sessionEvents: spec<M.SessionEvent>(
        'sessionEvents',
        'trustcargo.session_events',
        {
            id: uuid('id'),
            userId: uuid('user_id'),
            at: timestamp('at'),
            country: text('country'),
            deviceFingerprintHash: text('device_fingerprint_hash'),
            ipHash: text('ip_hash')
        },
        { appendOnly: true }
    ),
    screeningResults: spec<M.ScreeningResult>('screeningResults', 'trustcargo.screening_results', {
        id: uuid('id'),
        subjectType: text('subject_type'),
        subjectId: subjectOrOwner('subjectType', 'subject_type', 'subject'),
        provider: text('provider'),
        providerReference: text('provider_reference'),
        result: text('result'),
        listsChecked: textArray('lists_checked'),
        simulated: bool('simulated'),
        checkedAt: timestamp('checked_at')
    }),
    corridors: spec<M.Corridor>('corridors', 'trustcargo.corridors', {
        id: uuid('id'),
        code: text('code'),
        originCountry: text('origin_country'),
        destinationCountry: text('destination_country'),
        enabled: bool('enabled'),
        allowedCurrencies: textArray('allowed_currencies'),
        reviewThresholdMinor: json('review_threshold_minor'),
        expectedDischargePorts: textArray('expected_discharge_ports'),
        requiredDocumentsBeforeFunding: enumArray('trustcargo.document_type')('required_documents_before_funding'),
        updatedAt: timestamp('updated_at'),
        updatedBy: uuid('updated_by')
    }),
    transactions: spec<M.Transaction>(
        'transactions',
        'trustcargo.transactions',
        {
            id: uuid('id'),
            reference: text('reference'),
            type: text('type'),
            status: enumOf(TRANSACTION_STATUSES)('status'),
            title: text('title'),
            amount: amount('amount_minor', 'currency'),
            corridorId: uuid('corridor_id'),
            sellerOrganizationId: uuid('seller_organization_id'),
            createdBy: uuid('created_by'),
            currentContractVersionId: uuid('current_contract_version_id'),
            version: int('version'),
            createdAt: timestamp('created_at'),
            updatedAt: timestamp('updated_at'),
            fundedAt: timestamp('funded_at'),
            closedAt: timestamp('closed_at'),
            cancellationReason: text('cancellation_reason'),
            statusBeforeDispute: enumOf(TRANSACTION_STATUSES)('status_before_dispute'),
            isDemo: bool('is_demo')
        },
        { versioned: true }
    ),
    transactionParties: spec<M.TransactionParty>('transactionParties', 'trustcargo.transaction_parties', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        role: enumOf(PARTY_ROLES)('role'),
        userId: uuid('user_id'),
        organizationId: uuid('organization_id'),
        displayName: text('display_name'),
        email: text('email'),
        status: text('status'),
        invitationTokenHash: text('invitation_token_hash'),
        invitationExpiresAt: timestamp('invitation_expires_at'),
        joinedAt: timestamp('joined_at'),
        createdAt: timestamp('created_at')
    }),
    vehicles: spec<M.Vehicle>('vehicles', 'trustcargo.vehicles', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        make: text('make'),
        model: text('model'),
        year: int('year'),
        vin: text('vin'),
        mileageKm: int('mileage_km'),
        declaredCondition: text('declared_condition'),
        conditionNotes: text('condition_notes'),
        originCountry: text('origin_country'),
        destinationCountry: text('destination_country'),
        exteriorColor: text('exterior_color')
    }),
    contracts: spec<M.Contract>('contracts', 'trustcargo.contracts', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        createdAt: timestamp('created_at')
    }),
    contractVersions: spec<M.ContractVersion>('contractVersions', 'trustcargo.contract_versions', {
        id: uuid('id'),
        contractId: uuid('contract_id'),
        transactionId: uuid('transaction_id'),
        versionNumber: int('version_number'),
        terms: json('terms'),
        contentHash: text('content_hash'),
        status: text('status'),
        changeSummary: text('change_summary'),
        createdBy: uuid('created_by'),
        createdAt: timestamp('created_at')
    }),
    contractAcceptances: spec<M.ContractAcceptance>(
        'contractAcceptances',
        'trustcargo.contract_acceptances',
        {
            id: uuid('id'),
            transactionId: uuid('transaction_id'),
            contractVersionId: uuid('contract_version_id'),
            partyId: uuid('party_id'),
            userId: uuid('user_id'),
            decision: text('decision'),
            contentHash: text('content_hash'),
            comment: text('comment'),
            decidedAt: timestamp('decided_at')
        },
        { appendOnly: true }
    ),
    milestones: spec<M.Milestone>('milestones', 'trustcargo.milestones', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        contractVersionId: uuid('contract_version_id'),
        sequence: int('sequence'),
        key: text('key'),
        title: text('title'),
        description: text('description'),
        shareBps: int('share_bps'),
        amount: amount('amount_minor', 'currency'),
        requiredEvidence: enumArray('trustcargo.document_type')('required_evidence'),
        status: text('status'),
        submittedAt: timestamp('submitted_at'),
        submissionNote: text('submission_note'),
        decidedAt: timestamp('decided_at'),
        decidedBy: uuid('decided_by'),
        changeRequestReason: text('change_request_reason')
    }),
    milestoneEvidence: spec<M.MilestoneEvidence>('milestoneEvidence', 'trustcargo.milestone_evidence', {
        id: uuid('id'),
        milestoneId: uuid('milestone_id'),
        transactionId: uuid('transaction_id'),
        documentId: uuid('document_id'),
        addedBy: uuid('added_by'),
        addedAt: timestamp('added_at')
    }),
    documents: spec<M.Document>('documents', 'trustcargo.documents', {
        id: uuid('id'),
        logicalId: uuid('logical_id'),
        version: int('version'),
        transactionId: uuid('transaction_id'),
        ownerUserId: uuid('owner_user_id'),
        type: enumOf(DOCUMENT_TYPES)('type'),
        title: text('title'),
        fileName: text('file_name'),
        mimeType: text('mime_type'),
        sizeBytes: bigintAsNumber('size_bytes'),
        sha256: text('sha256'),
        storageKey: text('storage_key'),
        status: text('status'),
        visibleToRoles: textArray('visible_to_roles'),
        extracted: json('extracted'),
        extractionSource: text('extraction_source'),
        scan: (key) => nested({ status: text('scan_status'), engine: text('scan_engine'), scannedAt: timestamp('scanned_at') }, key),
        uploadedAt: timestamp('uploaded_at')
    }),
    documentVerifications: spec<M.DocumentVerification>(
        'documentVerifications',
        'trustcargo.document_verifications',
        {
            id: uuid('id'),
            documentId: uuid('document_id'),
            reviewerId: uuid('reviewer_id'),
            decision: text('decision'),
            notes: text('notes'),
            createdAt: timestamp('created_at')
        },
        { appendOnly: true }
    ),
    documentAccessLogs: spec<M.DocumentAccessLog>(
        'documentAccessLogs',
        'trustcargo.document_access_logs',
        { id: uuid('id'), documentId: uuid('document_id'), userId: uuid('user_id'), action: text('action'), at: timestamp('at') },
        { appendOnly: true }
    ),
    riskAlerts: spec<M.RiskAlert>('riskAlerts', 'trustcargo.risk_alerts', {
        id: uuid('id'),
        ruleId: text('rule_id'),
        category: text('category'),
        severity: text('severity'),
        transactionId: uuid('transaction_id'),
        subjectUserId: uuid('subject_user_id'),
        fingerprint: text('fingerprint'),
        reasons: json('reasons'),
        recommendedAction: text('recommended_action'),
        blocksFundsMovement: bool('blocks_funds_movement'),
        status: text('status'),
        createdAt: timestamp('created_at'),
        updatedAt: timestamp('updated_at')
    }),
    riskReviews: spec<M.RiskReview>(
        'riskReviews',
        'trustcargo.risk_reviews',
        {
            id: uuid('id'),
            alertId: uuid('alert_id'),
            reviewerId: uuid('reviewer_id'),
            decision: text('decision'),
            notes: text('notes'),
            createdAt: timestamp('created_at')
        },
        { appendOnly: true }
    ),
    disputes: spec<M.Dispute>('disputes', 'trustcargo.disputes', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        milestoneId: uuid('milestone_id'),
        openedBy: uuid('opened_by'),
        openedByRole: text('opened_by_role'),
        reason: text('reason'),
        description: text('description'),
        requestedOutcome: text('requested_outcome'),
        status: text('status'),
        responseDueAt: timestamp('response_due_at'),
        assignedTo: uuid('assigned_to'),
        createdAt: timestamp('created_at'),
        updatedAt: timestamp('updated_at'),
        resolvedAt: timestamp('resolved_at')
    }),
    disputeMessages: spec<M.DisputeMessage>(
        'disputeMessages',
        'trustcargo.dispute_messages',
        {
            id: uuid('id'),
            // transaction_id is denormalised for RLS: derived from the dispute, not part of the TS entity.
            disputeId: (key) =>
                withDerived(
                    uuid('dispute_id')(key),
                    'transaction_id',
                    (p) => `(select d.transaction_id from trustcargo.disputes d where d.id = ${p}::uuid)`
                ),
            authorId: uuid('author_id'),
            authorRole: text('author_role'),
            body: text('body'),
            documentIds: enumArray('uuid')('document_ids'),
            createdAt: timestamp('created_at')
        },
        { appendOnly: true }
    ),
    disputeDecisions: spec<M.DisputeDecision>(
        'disputeDecisions',
        'trustcargo.dispute_decisions',
        {
            id: uuid('id'),
            disputeId: uuid('dispute_id'),
            transactionId: uuid('transaction_id'),
            decidedBy: uuid('decided_by'),
            outcome: text('outcome'),
            // Both amounts share the decision's single currency column.
            sellerAmount: amount('seller_amount_minor', 'currency'),
            buyerRefundAmount: amount('buyer_refund_amount_minor', 'currency'),
            rationale: text('rationale'),
            contractClause: text('contract_clause'),
            mfaVerifiedAt: timestamp('mfa_verified_at'),
            createdAt: timestamp('created_at')
        },
        { appendOnly: true }
    ),
    complianceHolds: spec<M.ComplianceHold>('complianceHolds', 'trustcargo.compliance_holds', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        type: text('type'),
        status: text('status'),
        reference: text('reference'),
        notes: text('notes'),
        placedBy: uuid('placed_by'),
        placedAt: timestamp('placed_at'),
        liftedBy: uuid('lifted_by'),
        liftedAt: timestamp('lifted_at')
    }),
    paymentInstructions: spec<M.PaymentInstruction>('paymentInstructions', 'trustcargo.payment_instructions', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        provider: text('provider'),
        providerReference: text('provider_reference'),
        amount: amount('amount_minor', 'currency'),
        payerUserId: uuid('payer_user_id'),
        status: text('status'),
        details: json('details'),
        idempotencyKey: text('idempotency_key'),
        expiresAt: timestamp('expires_at'),
        createdAt: timestamp('created_at'),
        updatedAt: timestamp('updated_at'),
        failureReason: text('failure_reason')
    }),
    payouts: spec<M.Payout>('payouts', 'trustcargo.payouts', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        milestoneId: uuid('milestone_id'),
        disputeDecisionId: uuid('dispute_decision_id'),
        payeePartyId: uuid('payee_party_id'),
        paymentAccountId: uuid('payment_account_id'),
        amount: amount('amount_minor', 'currency'),
        status: text('status'),
        provider: text('provider'),
        providerReference: text('provider_reference'),
        idempotencyKey: text('idempotency_key'),
        requestedBy: text('requested_by'),
        requestedAt: timestamp('requested_at'),
        updatedAt: timestamp('updated_at'),
        attempts: int('attempts'),
        failureReason: text('failure_reason')
    }),
    refunds: spec<M.Refund>('refunds', 'trustcargo.refunds', {
        id: uuid('id'),
        transactionId: uuid('transaction_id'),
        disputeDecisionId: uuid('dispute_decision_id'),
        payerPartyId: uuid('payer_party_id'),
        amount: amount('amount_minor', 'currency'),
        status: text('status'),
        provider: text('provider'),
        providerReference: text('provider_reference'),
        idempotencyKey: text('idempotency_key'),
        requestedBy: text('requested_by'),
        requestedAt: timestamp('requested_at'),
        updatedAt: timestamp('updated_at'),
        attempts: int('attempts'),
        failureReason: text('failure_reason')
    }),
    providerEvents: spec<M.ProviderEvent>('providerEvents', 'trustcargo.provider_events', {
        id: uuid('id'),
        provider: text('provider'),
        externalEventId: text('external_event_id'),
        type: text('type'),
        payload: json('payload'),
        signatureVerified: bool('signature_verified'),
        status: text('status'),
        error: text('error'),
        transactionId: uuid('transaction_id'),
        occurredAt: timestamp('occurred_at'),
        receivedAt: timestamp('received_at'),
        processedAt: timestamp('processed_at')
    }),
    providerConnections: spec<M.ProviderConnection>('providerConnections', 'trustcargo.provider_connections', {
        id: uuid('id'),
        provider: text('provider'),
        displayName: text('display_name'),
        environment: text('environment'),
        status: text('status'),
        capabilities: textArray('capabilities'),
        webhookSecretRef: text('webhook_secret_ref'),
        regulatoryStatusNote: text('regulatory_status_note'),
        createdAt: timestamp('created_at')
    }),
    ledgerAccounts: spec<M.LedgerAccount>('ledgerAccounts', 'trustcargo.ledger_accounts', {
        id: uuid('id'),
        code: text('code'),
        name: text('name'),
        type: text('type'),
        currency: text('currency'),
        transactionId: uuid('transaction_id'),
        createdAt: timestamp('created_at')
    }),
    ledgerJournals: spec<M.LedgerJournal>(
        'ledgerJournals',
        'trustcargo.ledger_journals',
        {
            id: uuid('id'),
            idempotencyKey: text('idempotency_key'),
            kind: text('kind'),
            transactionId: uuid('transaction_id'),
            externalReference: text('external_reference'),
            providerEventId: uuid('provider_event_id'),
            description: text('description'),
            reversesJournalId: uuid('reverses_journal_id'),
            postedBy: text('posted_by'),
            postedAt: timestamp('posted_at')
        },
        { appendOnly: true }
    ),
    ledgerEntries: spec<M.LedgerEntry>(
        'ledgerEntries',
        'trustcargo.ledger_entries',
        {
            id: uuid('id'),
            journalId: uuid('journal_id'),
            accountId: uuid('account_id'),
            direction: text('direction'),
            amountMinor: bigint('amount_minor'),
            currency: text('currency')
        },
        { appendOnly: true }
    ),
    reconciliations: spec<M.Reconciliation>(
        'reconciliations',
        'trustcargo.reconciliations',
        {
            id: uuid('id'),
            provider: text('provider'),
            runBy: uuid('run_by'),
            runAt: timestamp('run_at'),
            status: text('status'),
            items: reconciliationItems
        },
        { appendOnly: true }
    ),
    auditEvents: spec<M.AuditEvent>(
        'auditEvents',
        'trustcargo.audit_events',
        {
            id: uuid('id'),
            sequence: bigintAsNumber('sequence'),
            at: timestamp('at'),
            actorType: text('actor_type'),
            actorId: text('actor_id'),
            action: text('action'),
            entityType: text('entity_type'),
            entityId: text('entity_id'),
            transactionId: uuid('transaction_id'),
            metadata: json('metadata'),
            previousHash: text('previous_hash'),
            hash: text('hash')
        },
        { appendOnly: true }
    ),
    notifications: spec<M.Notification>('notifications', 'trustcargo.notifications', {
        id: uuid('id'),
        userId: uuid('user_id'),
        type: text('type'),
        params: json('params'),
        transactionId: uuid('transaction_id'),
        readAt: timestamp('read_at'),
        createdAt: timestamp('created_at')
    }),
    // TypeScript id 'default' ↔ the single row (id = true). Insert updates that row (it exists after migration).
    securitySettings: spec<M.SecuritySettings & { id: string }>(
        'securitySettings',
        'trustcargo.security_settings',
        {
            id: () => singletonId('default'),
            adminMfaMaxAgeMinutes: int('admin_mfa_max_age_minutes'),
            sensitiveActionMfaMaxAgeMinutes: int('sensitive_action_mfa_max_age_minutes'),
            payoutAccountCoolingOffHours: int('payout_account_cooling_off_hours'),
            invitationTtlHours: int('invitation_ttl_hours'),
            signedUrlTtlSeconds: int('signed_url_ttl_seconds'),
            maxUploadBytes: bigintAsNumber('max_upload_bytes'),
            updatedAt: timestamp('updated_at'),
            updatedBy: uuid('updated_by')
        },
        { upsert: true }
    )
} satisfies Record<Exclude<keyof Db, 'nextSequence'>, TableSpec>;

/** Builds the Db port over one transaction's query function. */
export function createPgDb(query: Query, nextSequence: (name: string) => Promise<number>): Db {
    const tables = Object.fromEntries(
        Object.entries(TABLES).map(([key, s]) => [
            key,
            s.appendOnly ? new PgTable<{ id: string }>(s, query) : new PgMutableTable<{ id: string }>(s, query)
        ])
    ) as unknown as Omit<Db, 'nextSequence'>;
    return { ...tables, nextSequence };
}
