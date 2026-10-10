/**
 * Postgres adapter contract (runs with scripts/test-integration-pg.sh; skipped without TEST_PG_ADMIN_URL).
 * The rest of the integration suite runs unchanged on both adapters; this file checks what the services
 * cannot observe directly: lossless storage of every entity, ordering, errors, transactions, the audit
 * chain after a restart, cross-process serialisation and the SQL guards mirrored from TypeScript.
 */
import pg from 'pg';
import { describe, expect, it, onTestFinished } from 'vitest';
import { canonicalJson } from '@/domain/canonical';
import type * as M from '@/domain/model';
import { DOCUMENT_TYPES, PLATFORM_ROLES, TRANSACTION_STATUSES } from '@/domain/model';
import { money } from '@/domain/money';
import { canMovePayout, canMoveRefund, getTransition, TRANSITIONS, type TransitionId } from '@/domain/transaction/state-machine';
import { MemoryDatabase } from '@/server/adapters/memory/memory-db';
import { InvalidValueError } from '@/server/adapters/postgres/codecs';
import { DEFAULT_TIMEOUTS, PostgresDatabase, type UnitOfWorkTimeouts } from '@/server/adapters/postgres/pg-database';
import { TABLES } from '@/server/adapters/postgres/tables';
import { UuidV7Generator } from '@/server/adapters/uuid-v7';
import { createApp } from '@/server/app';
import { loadConfig } from '@/server/config';
import { seedReferenceData } from '@/server/demo/seed';
import { ConcurrencyError, UniqueViolationError, type Db } from '@/server/ports/db';
import { sha256Hex } from '@/server/security/crypto';
import { AUDIT_GENESIS_HASH, DEFAULT_SECURITY_SETTINGS } from '@/server/services/context';
import { actors } from './helpers';
import { captureProcessErrors, createTestDatabase, databaseUrl, usePostgres } from './pg-test-db';
import { payAllSubmitted, submitMilestone, toInProgress } from './flow';

type TableKey = Exclude<keyof Db, 'nextSequence'>;
type Fixture = [TableKey, { id: string } & Record<string, unknown>];

const gen = new UuidV7Generator();
const id = () => gen.id();
const at = (second: number) => new Date(Date.UTC(2026, 0, 10, 14, 0, second, 123)).toISOString();
const hex = (seed: string) => sha256Hex(seed);

/** A fresh migrated database opened by the adapter as service_role, plus a superuser client for checks. */
async function openDatabase(options: { timeZone?: string } = {}) {
    const database = await createTestDatabase();
    const url = options.timeZone ? databaseUrl(database.name, { options: `-c TimeZone=${options.timeZone}` }) : database.url;
    const uow = new PostgresDatabase({ url, role: 'service_role', poolMax: 3 });
    const raw = new pg.Client({ connectionString: database.url });
    await raw.connect();
    onTestFinished(async () => {
        await uow.close();
        await raw.end();
        await database.drop();
    });
    return { database, uow, raw };
}

/** Rows of every table, in foreign-key order. `full` sets every optional field; otherwise none is set. */
function graph(tag: string, full: boolean): Fixture[] {
    const user = id();
    const org = id();
    const tx = id();
    const contract = id();
    const version = id();
    const seller = id();
    const buyer = id();
    const milestone = id();
    const doc = id();
    const dispute = id();
    const decision = id();
    const event = id();
    const accountBase = id();
    const account = id();
    const ledgerA = id();
    const ledgerB = id();
    const journal = id();
    const alert = id();
    const opt = <T extends Record<string, unknown>>(fields: T): Partial<T> => (full ? fields : {});
    const terms = {
        goodsDescription: 'Toyota RAV4 2021 — « état décrit » ✓',
        totalAmount: { amountMinor: '1850000', currency: 'CAD' },
        sellerResponsibilities: 's',
        buyerResponsibilities: 'b',
        inspectionTerms: 'i',
        shippingTerms: 'CFR Dakar',
        deliveryTerms: 'd',
        releaseTerms: 'r',
        refundTerms: 'f',
        disputeProcedure: 'p',
        deadlines: { inspectionDays: 7, shippingDays: 21, deliveryDays: 45, reviewDays: 7 },
        milestones: [{ key: 'initial-checks', title: 'Inspection', description: 'x', shareBps: 10_000, requiredEvidence: ['PHOTO'] }]
    };
    const journalRows: Fixture[] = [
        [
            'ledgerJournals',
            {
                id: journal,
                idempotencyKey: `funds:${tag}`,
                kind: 'FUNDS_REPORTED_RECEIVED',
                description: 'Funds',
                postedBy: 'mock',
                postedAt: at(40),
                ...opt({ transactionId: tx, externalReference: `SIM-${tag}`, providerEventId: event })
            }
        ],
        [
            'ledgerEntries',
            { id: id(), journalId: journal, accountId: ledgerA, direction: 'DEBIT', amountMinor: 9_007_199_254_740_993n, currency: 'CAD' }
        ],
        [
            'ledgerEntries',
            { id: id(), journalId: journal, accountId: ledgerB, direction: 'CREDIT', amountMinor: 9_007_199_254_740_993n, currency: 'CAD' }
        ]
    ];
    if (full) {
        const reversal = id();
        journalRows.push(
            [
                'ledgerJournals',
                {
                    id: reversal,
                    idempotencyKey: `reversal:${journal}`,
                    kind: 'REVERSAL',
                    transactionId: tx,
                    externalReference: `SIM-${tag}`,
                    description: 'Reversal',
                    reversesJournalId: journal,
                    postedBy: user,
                    postedAt: at(41)
                }
            ],
            [
                'ledgerEntries',
                {
                    id: id(),
                    journalId: reversal,
                    accountId: ledgerA,
                    direction: 'CREDIT',
                    amountMinor: 9_007_199_254_740_993n,
                    currency: 'CAD'
                }
            ],
            [
                'ledgerEntries',
                {
                    id: id(),
                    journalId: reversal,
                    accountId: ledgerB,
                    direction: 'DEBIT',
                    amountMinor: 9_007_199_254_740_993n,
                    currency: 'CAD'
                }
            ]
        );
    }
    return [
        [
            'users',
            {
                id: user,
                email: `persona-${tag}@demo.trustcargo.test`,
                fullName: 'Awa Test',
                country: 'SN',
                locale: 'fr',
                platformRoles: full ? ['document_reviewer', 'compliance_analyst'] : [],
                kycStatus: 'VERIFIED',
                status: 'ACTIVE',
                createdAt: at(1),
                isDemo: true,
                ...opt({ phone: '+221 77 000 00 00', city: 'Dakar', mfaTotpSecret: 'JBSWY3DPEHPK3PXP' })
            }
        ],
        [
            'organizations',
            {
                id: org,
                legalName: `Autos ${tag} inc.`,
                registrationNumber: `NEQ-${tag}`,
                country: 'CA',
                type: 'DEALER',
                kybStatus: 'PENDING',
                createdAt: at(2),
                ...opt({ tradeName: 'Autos', city: 'Montréal' })
            }
        ],
        ['organizationMembers', { id: id(), organizationId: org, userId: user, role: 'OWNER', createdAt: at(3) }],
        [
            'identityVerifications',
            full
                ? {
                      id: id(),
                      subjectType: 'USER',
                      subjectId: user,
                      provider: 'mock-kyc',
                      providerReference: `kyc-${tag}`,
                      status: 'VERIFIED',
                      level: 'ENHANCED',
                      verifiedName: 'Awa Test',
                      documentType: 'PASSPORT',
                      documentCountry: 'SN',
                      documentExpiresAt: '2031-06-30',
                      checks: [{ code: 'LIVENESS', result: 'PASS' }],
                      reviewedBy: user,
                      reviewNote: 'ok',
                      simulated: true,
                      createdAt: at(4),
                      completedAt: at(5)
                  }
                : {
                      id: id(),
                      subjectType: 'ORGANIZATION',
                      subjectId: org,
                      provider: 'mock-kyc',
                      providerReference: `kyb-${tag}`,
                      status: 'PENDING',
                      level: 'BASIC',
                      checks: [],
                      simulated: false,
                      createdAt: at(4)
                  }
        ],
        [
            'beneficialOwners',
            {
                id: id(),
                organizationId: org,
                fullName: 'Awa Test',
                ownershipBps: 10_000,
                country: 'SN',
                verificationStatus: 'NOT_STARTED',
                createdAt: at(5)
            }
        ],
        [
            'paymentAccounts',
            {
                id: accountBase,
                ownerType: 'USER',
                ownerId: user,
                holderName: 'Awa',
                currency: 'XOF',
                country: 'SN',
                bankName: 'Banque fictive',
                maskedIdentifier: '•••• 0001',
                providerToken: `sim_vault_${tag}_0`,
                status: 'PENDING_VERIFICATION',
                createdAt: at(6)
            }
        ],
        [
            'paymentAccounts',
            {
                id: account,
                ownerType: 'ORGANIZATION',
                ownerId: org,
                holderName: 'Autos',
                currency: 'CAD',
                country: 'CA',
                bankName: 'Banque fictive',
                maskedIdentifier: '•••• 4821',
                providerToken: `sim_vault_${tag}_1`,
                status: full ? 'DISABLED' : 'VERIFIED',
                createdAt: at(7),
                ...opt({ verifiedAt: at(8), disabledAt: at(9), replacesAccountId: accountBase })
            }
        ],
        [
            'sessionEvents',
            { id: id(), userId: user, at: at(10), country: 'SN', deviceFingerprintHash: 'ab'.repeat(16), ipHash: hex(`ip-${tag}`) }
        ],
        [
            'screeningResults',
            {
                id: id(),
                subjectType: 'USER',
                subjectId: user,
                provider: 'mock-screening',
                providerReference: `scr-${tag}`,
                result: 'NO_MATCH',
                listsChecked: full ? ['SIMULATED-LIST', 'with, comma "quotes" {braces} \\ backslash'] : [],
                simulated: true,
                checkedAt: at(11)
            }
        ],
        [
            'corridors',
            {
                id: id(),
                code: `C-${tag.toUpperCase()}`,
                originCountry: 'CA',
                destinationCountry: full ? 'SN' : 'CI',
                enabled: full,
                allowedCurrencies: full ? ['CAD', 'XOF'] : [],
                reviewThresholdMinor: full ? { CAD: '5000000', XOF: '2200000000' } : {},
                expectedDischargePorts: full ? ['Dakar', 'Port autonome de Dakar'] : [],
                requiredDocumentsBeforeFunding: full ? ['TITLE', 'INVOICE'] : [],
                updatedAt: at(12),
                ...opt({ updatedBy: user })
            }
        ],
        [
            'corridors',
            {
                id: id(),
                code: `D-${tag.toUpperCase()}`,
                originCountry: 'CA',
                destinationCountry: 'SN',
                enabled: true,
                allowedCurrencies: ['CAD'],
                reviewThresholdMinor: {},
                expectedDischargePorts: [],
                requiredDocumentsBeforeFunding: [],
                updatedAt: at(12)
            }
        ],
        [
            'transactions',
            {
                id: tx,
                reference: `TC-2026-${tag.toUpperCase()}`,
                type: 'VEHICLE_PURCHASE',
                status: full ? 'DISPUTED' : 'DRAFT',
                title: 'Toyota RAV4 2021',
                amount: money(9_007_199_254_740_993n, 'CAD'),
                corridorId: '',
                createdBy: user,
                version: 1,
                createdAt: at(13),
                updatedAt: at(14),
                isDemo: true,
                ...opt({
                    sellerOrganizationId: org,
                    currentContractVersionId: version,
                    fundedAt: at(15),
                    closedAt: at(16),
                    cancellationReason: 'n/a',
                    statusBeforeDispute: 'IN_PROGRESS'
                })
            }
        ],
        [
            'transactionParties',
            {
                id: seller,
                transactionId: tx,
                role: 'SELLER',
                displayName: 'Autos',
                email: `seller-${tag}@demo.trustcargo.test`,
                status: full ? 'JOINED' : 'INVITED',
                createdAt: at(17),
                ...opt({
                    userId: user,
                    organizationId: org,
                    invitationTokenHash: hex(`token-${tag}`),
                    invitationExpiresAt: at(18),
                    joinedAt: at(19)
                })
            }
        ],
        [
            'transactionParties',
            {
                id: buyer,
                transactionId: tx,
                role: 'BUYER',
                displayName: 'Awa',
                email: `buyer-${tag}@demo.trustcargo.test`,
                status: 'INVITED',
                createdAt: at(17)
            }
        ],
        [
            'vehicles',
            {
                id: id(),
                transactionId: tx,
                make: 'Toyota',
                model: 'RAV4',
                year: 2021,
                vin: '2T3W1RFV7MC123456',
                mileageKm: 62_300,
                declaredCondition: 'GOOD',
                originCountry: 'CA',
                destinationCountry: 'SN',
                ...opt({ conditionNotes: 'Pneus d’hiver', exteriorColor: 'Bleu' })
            }
        ],
        ['contracts', { id: contract, transactionId: tx, createdAt: at(20) }],
        [
            'contractVersions',
            {
                id: version,
                contractId: contract,
                transactionId: tx,
                versionNumber: 1,
                terms,
                contentHash: hex(canonicalJson(terms)),
                status: 'ACCEPTED',
                createdBy: user,
                createdAt: at(21),
                ...opt({ changeSummary: 'Initial' })
            }
        ],
        [
            'contractAcceptances',
            {
                id: id(),
                transactionId: tx,
                contractVersionId: version,
                partyId: seller,
                userId: user,
                decision: 'ACCEPTED',
                contentHash: hex(canonicalJson(terms)),
                decidedAt: at(22),
                ...opt({ comment: 'Lu et accepté.' })
            }
        ],
        [
            'milestones',
            {
                id: milestone,
                transactionId: tx,
                contractVersionId: version,
                sequence: 1,
                key: 'initial-checks',
                title: 'Inspection',
                description: 'Rapport',
                shareBps: 10_000,
                amount: money(9_007_199_254_740_993n, 'CAD'),
                requiredEvidence: full ? ['INSPECTION_REPORT', 'PHOTO'] : [],
                status: full ? 'CHANGES_REQUESTED' : 'PENDING',
                ...opt({ submittedAt: at(23), submissionNote: 'note', decidedAt: at(24), decidedBy: user, changeRequestReason: 'Photos' })
            }
        ],
        [
            'documents',
            full
                ? {
                      id: doc,
                      logicalId: id(),
                      version: 1,
                      transactionId: tx,
                      ownerUserId: user,
                      type: 'INVOICE',
                      title: 'Facture',
                      fileName: 'facture.pdf',
                      mimeType: 'application/pdf',
                      sizeBytes: 1234,
                      sha256: hex(`doc-${tag}`),
                      storageKey: `${tx}/x/v1-abc`,
                      status: 'PENDING_REVIEW',
                      visibleToRoles: ['SELLER', 'BUYER'],
                      extracted: { vin: '2T3W1RFV7MC123456', amount: { amountMinor: '1850000', currency: 'CAD' } },
                      extractionSource: 'DECLARED',
                      scan: { status: 'CLEAN', engine: 'eicar-signature-check (placeholder)', scannedAt: at(25) },
                      uploadedAt: at(25)
                  }
                : {
                      id: doc,
                      logicalId: id(),
                      version: 2,
                      ownerUserId: user,
                      type: 'OTHER',
                      title: 'Note',
                      fileName: 'note.png',
                      mimeType: 'image/png',
                      sizeBytes: 1,
                      sha256: hex(`doc-${tag}`),
                      storageKey: `free/${tag}`,
                      status: 'SCAN_PENDING',
                      visibleToRoles: [],
                      extracted: {},
                      extractionSource: 'NONE',
                      scan: { status: 'ERROR', engine: 'none' },
                      uploadedAt: at(25)
                  }
        ],
        ...(full
            ? ([
                  [
                      'milestoneEvidence',
                      { id: id(), milestoneId: milestone, transactionId: tx, documentId: doc, addedBy: user, addedAt: at(26) }
                  ]
              ] as Fixture[])
            : []),
        ['documentVerifications', { id: id(), documentId: doc, reviewerId: user, decision: 'NEEDS_INFO', notes: '', createdAt: at(27) }],
        ['documentAccessLogs', { id: id(), documentId: doc, userId: user, action: 'DENIED', at: at(28) }],
        [
            'riskAlerts',
            {
                id: alert,
                ruleId: 'TX_AMOUNT_ABOVE_THRESHOLD',
                category: 'TRANSACTION',
                severity: 'HIGH',
                fingerprint: `fp-${tag}`,
                reasons: [{ code: 'AMOUNT', params: { amountMinor: '1', ratio: 1.5 } }],
                recommendedAction: 'ENHANCED_REVIEW',
                blocksFundsMovement: full,
                status: 'OPEN',
                createdAt: at(29),
                updatedAt: at(29),
                subjectUserId: user,
                ...opt({ transactionId: tx })
            }
        ],
        ['riskReviews', { id: id(), alertId: alert, reviewerId: user, decision: 'ESCALATED', notes: 'Escalade', createdAt: at(30) }],
        [
            'disputes',
            {
                id: dispute,
                transactionId: tx,
                openedBy: user,
                openedByRole: 'BUYER',
                reason: 'NOT_DELIVERED',
                description: 'Retard',
                requestedOutcome: 'Remboursement',
                status: full ? 'RESOLVED' : 'AWAITING_RESPONSE',
                responseDueAt: at(31),
                createdAt: at(31),
                updatedAt: at(32),
                ...opt({ milestoneId: milestone, assignedTo: user, resolvedAt: at(33) })
            }
        ],
        [
            'disputeMessages',
            {
                id: id(),
                disputeId: dispute,
                authorId: user,
                authorRole: 'PLATFORM',
                body: 'Message',
                documentIds: full ? [doc] : [],
                createdAt: at(34)
            }
        ],
        ...(full
            ? ([
                  [
                      'disputeDecisions',
                      {
                          id: decision,
                          disputeId: dispute,
                          transactionId: tx,
                          decidedBy: user,
                          outcome: 'SPLIT',
                          sellerAmount: money(1_700_000n, 'CAD'),
                          buyerRefundAmount: money(150_000n, 'CAD'),
                          rationale: 'Partage',
                          contractClause: 'Art. 4',
                          mfaVerifiedAt: at(35),
                          createdAt: at(35)
                      }
                  ]
              ] as Fixture[])
            : []),
        [
            'complianceHolds',
            {
                id: id(),
                transactionId: tx,
                type: 'COURT_ORDER',
                status: full ? 'LIFTED' : 'ACTIVE',
                reference: 'CASE-1',
                notes: '',
                placedBy: user,
                placedAt: at(36),
                ...opt({ liftedBy: user, liftedAt: at(37) })
            }
        ],
        [
            'paymentInstructions',
            {
                id: id(),
                transactionId: tx,
                provider: 'mock',
                providerReference: `PI-${tag}`,
                amount: money(1_850_000n, 'CAD'),
                payerUserId: user,
                status: full ? 'FAILED' : 'CREATED',
                details: {
                    method: 'BANK_TRANSFER',
                    beneficiaryName: 'Partenaire (simulation)',
                    bankName: 'Banque fictive',
                    accountMasked: '•••• 0001',
                    paymentReference: 'TC',
                    notes: 'SIMULATION'
                },
                idempotencyKey: `fund:${tag}`,
                expiresAt: at(38),
                createdAt: at(38),
                updatedAt: at(39),
                ...opt({ failureReason: 'Rejet' })
            }
        ],
        [
            'payouts',
            {
                id: id(),
                transactionId: tx,
                payeePartyId: seller,
                paymentAccountId: account,
                amount: money(1_700_000n, 'CAD'),
                status: full ? 'FAILED' : 'REQUESTED',
                provider: 'mock',
                idempotencyKey: `payout:${tag}`,
                requestedBy: full ? 'system' : user,
                requestedAt: at(39),
                updatedAt: at(39),
                attempts: full ? 2 : 0,
                ...opt({
                    milestoneId: milestone,
                    disputeDecisionId: decision,
                    providerReference: `PO-${tag}`,
                    failureReason: 'Compte fermé'
                })
            }
        ],
        [
            'refunds',
            {
                id: id(),
                transactionId: tx,
                payerPartyId: buyer,
                amount: money(150_000n, 'CAD'),
                status: full ? 'FAILED' : 'REQUESTED',
                provider: 'mock',
                idempotencyKey: `refund:${tag}`,
                requestedBy: user,
                requestedAt: at(39),
                updatedAt: at(39),
                attempts: 0,
                ...opt({ disputeDecisionId: decision, providerReference: `RF-${tag}`, failureReason: 'Rejet' })
            }
        ],
        [
            'providerEvents',
            {
                id: event,
                provider: 'mock',
                externalEventId: `evt-${tag}`,
                type: 'funds.confirmed',
                payload: { id: `evt-${tag}`, data: { amountMinor: '1850000' }, list: [1, 'two', null, true, { deep: 'é' }] },
                signatureVerified: full,
                status: full ? 'FAILED' : 'RECEIVED',
                occurredAt: at(40),
                receivedAt: at(40),
                ...opt({ error: 'AMOUNT_MISMATCH', transactionId: tx, processedAt: at(41) })
            }
        ],
        [
            'providerConnections',
            {
                id: id(),
                provider: `mock-${tag}`,
                displayName: 'Partenaire simulé',
                environment: 'SIMULATION',
                status: 'ACTIVE',
                capabilities: full ? ['webhooks', 'statements'] : [],
                webhookSecretRef: 'MOCK_PROVIDER_WEBHOOK_SECRET',
                regulatoryStatusNote: 'Simulation — aucun fonds réel.',
                createdAt: at(41)
            }
        ],
        [
            'ledgerAccounts',
            { id: ledgerA, code: `PARTNER_CLEARING:${tag}:CAD`, name: 'Clearing', type: 'ASSET', currency: 'CAD', createdAt: at(42) }
        ],
        [
            'ledgerAccounts',
            {
                id: ledgerB,
                code: `TX_HELD:${tag}:CAD`,
                name: 'Held',
                type: 'LIABILITY',
                currency: 'CAD',
                createdAt: at(42),
                ...opt({ transactionId: tx })
            }
        ],
        ...journalRows,
        [
            'reconciliations',
            {
                id: id(),
                provider: 'mock',
                runBy: user,
                runAt: at(43),
                status: full ? 'DISCREPANCIES' : 'MATCHED',
                items: full
                    ? [
                          {
                              externalReference: 'A',
                              kind: 'FUNDS',
                              providerAmountMinor: '9007199254740993',
                              ledgerAmountMinor: '9007199254740993',
                              currency: 'CAD',
                              result: 'MATCHED'
                          },
                          {
                              externalReference: 'B',
                              kind: 'PAYOUT_PAID',
                              providerAmountMinor: '1',
                              currency: 'XOF',
                              result: 'MISSING_IN_LEDGER'
                          },
                          {
                              externalReference: 'C',
                              kind: 'REFUND_SETTLED',
                              ledgerAmountMinor: '2',
                              currency: 'EUR',
                              result: 'MISSING_AT_PROVIDER'
                          }
                      ]
                    : []
            }
        ],
        [
            'notifications',
            {
                id: id(),
                userId: user,
                type: 'dispute.opened',
                params: full ? { reference: 'TC-1', note: '« guillemets »' } : {},
                createdAt: at(44),
                ...opt({ transactionId: tx, readAt: at(45) })
            }
        ]
    ];
}

/** Audit events forming a valid chain (sequence + previous hash), USER/SYSTEM/PROVIDER actors. */
function auditChain(start: number, previous: string, txId: string, userId: string): M.AuditEvent[] {
    const bodies = [
        {
            id: id(),
            sequence: start,
            at: at(50),
            actorType: 'USER' as const,
            actorId: userId,
            action: 'transaction.created',
            entityType: 'transaction',
            entityId: txId,
            transactionId: txId,
            metadata: { amountMinor: '1850000', nested: { list: [1, 'a'] } }
        },
        {
            id: id(),
            sequence: start + 1,
            at: at(51),
            actorType: 'SYSTEM' as const,
            actorId: 'system',
            action: 'config.security_settings_updated',
            entityType: 'security_settings',
            entityId: 'default',
            metadata: {}
        },
        {
            id: id(),
            sequence: start + 2,
            at: at(52),
            actorType: 'PROVIDER' as const,
            action: 'provider_event.rejected',
            entityType: 'provider_event',
            entityId: 'unverified',
            metadata: { reason: 'MISMATCH' }
        }
    ];
    const out: M.AuditEvent[] = [];
    for (const body of bodies) {
        const hash = sha256Hex(previous + canonicalJson(body));
        out.push({ ...body, previousHash: previous, hash });
        previous = hash;
    }
    return out;
}

async function insertAll(db: Db, rows: Fixture[]) {
    const corridorId = rows.find(([t]) => t === 'corridors')![1].id;
    for (const [table, row] of rows) {
        if (table === 'transactions') row.corridorId = corridorId;
        await (db[table] as unknown as { insert(r: unknown): Promise<unknown> }).insert(row);
    }
}

describe.skipIf(!usePostgres)('Postgres adapter', () => {
    it('round-trips every table losslessly, optional fields set and unset (session time zone UTC+14)', async () => {
        const { uow } = await openDatabase({ timeZone: 'Pacific/Kiritimati' });
        const full = graph('full', true);
        const minimal = graph('min', false);
        const tx = full.find(([t]) => t === 'transactions')![1];
        const user = full.find(([t]) => t === 'users')![1];
        const audits = auditChain(1, AUDIT_GENESIS_HASH, tx.id, user.id);
        await uow.run(async (db) => {
            await insertAll(db, full);
            await insertAll(db, minimal);
            for (const e of audits) await db.auditEvents.insert(e);
        });
        const covered = new Set([...full, ...minimal].map(([t]) => t).concat('auditEvents', 'securitySettings'));
        expect([...covered].sort()).toEqual(Object.keys(TABLES).sort());

        await uow.run(async (db) => {
            for (const [table, row] of [...full, ...minimal]) expect(await db[table].get(row.id)).toStrictEqual(row);
            for (const e of audits) expect(await db.auditEvents.get(e.id)).toStrictEqual(e);
            // Polymorphic ids are filterable like any field; the discriminator narrows them.
            const org = full.find(([t]) => t === 'organizations')![1].id;
            expect((await db.paymentAccounts.findBy({ ownerId: org })).map((a) => a.ownerType)).toEqual(['ORGANIZATION']);
            expect(await db.identityVerifications.findBy({ subjectType: 'ORGANIZATION', subjectId: user.id })).toEqual([]);
            expect(await db.users.findOne({ mfaTotpSecret: 'JBSWY3DPEHPK3PXP' })).toMatchObject({ id: user.id });
            expect(await db.auditEvents.findOne({ sequence: 2 })).toStrictEqual(audits[1]);
            expect(await db.documents.findBy({ sizeBytes: 1234 })).toHaveLength(1);
            expect(await db.ledgerEntries.findBy({ amountMinor: 9_007_199_254_740_993n })).toHaveLength(6);
            expect(await db.identityVerifications.findBy({ documentExpiresAt: '2031-06-30' })).toHaveLength(1);
        });
    });

    it('stores the single security settings row under the TypeScript id "default"', async () => {
        const { uow } = await openDatabase();
        await uow.run(async (db) => {
            // The migration creates the row with the TypeScript defaults; insert updates it.
            expect(await db.securitySettings.get('default')).toStrictEqual({
                id: 'default',
                ...DEFAULT_SECURITY_SETTINGS,
                updatedAt: expect.any(String)
            });
            const row = { id: 'default', ...DEFAULT_SECURITY_SETTINGS, payoutAccountCoolingOffHours: 96, updatedAt: at(1) };
            await db.securitySettings.insert(row);
            expect(await db.securitySettings.get('default')).toStrictEqual(row);
            expect(await db.securitySettings.list()).toStrictEqual([row]);
            const updated = await db.securitySettings.update('default', {
                ...row,
                updatedBy: undefined,
                sensitiveActionMfaMaxAgeMinutes: 5
            });
            expect(updated).toStrictEqual({ ...row, sensitiveActionMfaMaxAgeMinutes: 5 });
            expect(await db.securitySettings.get('other')).toBeUndefined();
            await expect(db.securitySettings.insert({ ...row, id: 'other' })).rejects.toBeInstanceOf(InvalidValueError);
        });
    });

    it('merges update patches like memory: undefined clears, related rows are replaced, unknown ids and fields fail', async () => {
        const { uow } = await openDatabase();
        const rows = graph('upd', true);
        await uow.run((db) => insertAll(db, rows));
        const user = rows.find(([t]) => t === 'users')![1];
        const tx = rows.find(([t]) => t === 'transactions')![1];
        await uow.run(async (db) => {
            const u = await db.users.update(user.id, {
                platformRoles: ['auditor', 'finance_operator'],
                mfaTotpSecret: undefined,
                city: undefined
            });
            expect(u.platformRoles).toEqual(['auditor', 'finance_operator']);
            expect(u).not.toHaveProperty('mfaTotpSecret');
            expect(u).not.toHaveProperty('city');
            expect(u.phone).toBe(user.phone);
            const t = await db.transactions.update(tx.id, { fundedAt: undefined, title: 'Renamed' });
            expect(t).not.toHaveProperty('fundedAt');
            expect(t).toMatchObject({ title: 'Renamed', closedAt: tx.closedAt, version: 2 });
            await expect(db.notifications.update(id(), { readAt: at(1) })).rejects.toThrow(/notifications .* not found/);
            await expect(db.notifications.update('not-a-uuid', { readAt: at(1) })).rejects.toThrow(/not found/);
            await expect(
                db.notifications.insert({ id: 'm-colleague', userId: user.id, type: 'x', params: {}, createdAt: at(1) })
            ).rejects.toBeInstanceOf(InvalidValueError);
            await expect(db.users.update(user.id, { nickname: 'x' } as Partial<M.User>)).rejects.toBeInstanceOf(InvalidValueError);
        });
        // Filters that can never match a stored value return nothing instead of a database error.
        await uow.run(async (db) => {
            expect(await db.users.get('not-a-uuid')).toBeUndefined();
            expect(await db.transactions.findBy({ status: 'NOT_A_STATUS' as M.TransactionStatus })).toEqual([]);
            expect(await db.transactions.findBy({ createdAt: 'yesterday' })).toEqual([]);
            expect(await db.transactions.findBy({ amount: tx.amount as M.Transaction['amount'] })).toEqual([]);
            expect(await db.transactions.findBy({ cancellationReason: undefined, id: tx.id })).toHaveLength(1);
        });
    });

    it('orders rows by id (UUIDv7 = creation order) and applies list limits', async () => {
        const { uow } = await openDatabase();
        const rows = graph('ord', false);
        await uow.run((db) => insertAll(db, rows));
        const user = rows.find(([t]) => t === 'users')![1].id;
        const earlier = rows.find(([t]) => t === 'notifications')![1].id;
        const [a, b, c] = [id(), id(), id()];
        await uow.run(async (db) => {
            // Inserted out of order: reads still follow id (= creation) order, like memory's insertion order.
            for (const n of [c, a, b])
                await db.notifications.insert({ id: n, userId: user, type: 'ordered', params: {}, createdAt: at(1) });
            expect((await db.notifications.list()).map((n) => n.id)).toEqual([earlier, a, b, c]);
            expect((await db.notifications.findBy({ type: 'ordered' })).map((n) => n.id)).toEqual([a, b, c]);
            expect((await db.notifications.findOne({ type: 'ordered' }))!.id).toBe(a);
            expect((await db.notifications.list({ limit: 2 })).map((n) => n.id)).toEqual([earlier, a]);
        });
    });

    it('maps unique violations and stale optimistic locks to the port errors; version moves by exactly 1', async () => {
        const { uow } = await openDatabase();
        const rows = graph('err', false);
        await uow.run((db) => insertAll(db, rows));
        const tx = rows.find(([t]) => t === 'transactions')![1] as unknown as M.Transaction;
        const duplicate = uow.run((db) => db.transactions.insert({ ...tx, id: id() }));
        await expect(duplicate).rejects.toBeInstanceOf(UniqueViolationError);
        await expect(duplicate).rejects.toMatchObject({ table: 'transactions', constraint: 'transactions_reference_key' });
        await expect(uow.run((db) => db.transactions.insert(tx))).rejects.toMatchObject({ table: 'transactions', constraint: 'id' });

        await uow.run(async (db) => {
            const v2 = await db.transactions.update(tx.id, { title: 'A', version: 42 }, { expectedVersion: 1 });
            expect(v2.version).toBe(2);
            expect((await db.transactions.update(tx.id, {})).version).toBe(3);
        });
        await expect(uow.run((db) => db.transactions.update(tx.id, { title: 'B' }, { expectedVersion: 1 }))).rejects.toBeInstanceOf(
            ConcurrencyError
        );
        expect((await uow.run((db) => db.transactions.get(tx.id)))!.title).toBe('A');
    });

    it('rolls a unit of work back on error, joins nested runs and keeps counters gap-free', async () => {
        const { uow } = await openDatabase();
        const rows = graph('uow', false);
        await uow.run((db) => insertAll(db, rows));
        const user = rows.find(([t]) => t === 'users')![1].id;
        const note = (n: string) => ({ id: n, userId: user, type: 'x', params: {}, createdAt: at(1) });

        const lost = id();
        await expect(
            uow.run(async (db) => {
                await db.notifications.insert(note(lost));
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        // A database error in the middle also discards the earlier writes of the unit of work.
        const alsoLost = id();
        await expect(
            uow.run(async (db) => {
                await db.notifications.insert(note(alsoLost));
                await db.notifications.insert(note(alsoLost));
            })
        ).rejects.toBeInstanceOf(UniqueViolationError);
        expect(await uow.run((db) => db.notifications.get(lost))).toBeUndefined();
        expect(await uow.run((db) => db.notifications.get(alsoLost))).toBeUndefined();

        const inner = id();
        await expect(
            uow.run(async (outer) => {
                await uow.run(async (nested) => {
                    expect(nested).toBe(outer);
                    await nested.notifications.insert(note(inner));
                });
                expect(await outer.notifications.get(inner)).toBeDefined();
                throw new Error('outer fails');
            })
        ).rejects.toThrow('outer fails');
        expect(await uow.run((db) => db.notifications.get(inner))).toBeUndefined();

        expect(await uow.run((db) => db.nextSequence('transaction_reference'))).toBe(1);
        await expect(
            uow.run(async (db) => {
                await db.nextSequence('transaction_reference');
                throw new Error('rolled back');
            })
        ).rejects.toThrow();
        expect(await uow.run((db) => db.nextSequence('transaction_reference'))).toBe(2);
        expect(await uow.run((db) => db.nextSequence('audit'))).toBe(1);
    });

    it('exposes no update on append-only tables (same set as memory) and the database refuses one', async () => {
        const { uow, raw } = await openDatabase();
        const memory = new MemoryDatabase();
        await uow.run(async (db) => {
            for (const key of Object.keys(TABLES) as TableKey[]) {
                expect([key, typeof (db[key] as { update?: unknown }).update]).toEqual([
                    key,
                    typeof (memory.db[key] as { update?: unknown }).update
                ]);
            }
            const body = {
                id: id(),
                sequence: 1,
                at: at(1),
                actorType: 'SYSTEM' as const,
                actorId: 'system',
                action: 'system.seeded',
                entityType: 'system',
                entityId: 'seed',
                metadata: {}
            };
            await db.auditEvents.insert({
                ...body,
                previousHash: AUDIT_GENESIS_HASH,
                hash: sha256Hex(AUDIT_GENESIS_HASH + canonicalJson(body))
            });
        });
        await raw.query('begin');
        await raw.query('set local role service_role');
        await expect(raw.query("update trustcargo.audit_events set action = 'tampered'")).rejects.toMatchObject({ code: '42501' });
        await raw.query('rollback');
    });

    it('validates the audit chain after a round trip through Postgres and a restart', async () => {
        const database = await createTestDatabase();
        const env = (url: string) =>
            loadConfig({
                TRUSTCARGO_MODE: 'demo',
                SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
                MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
                DATABASE_URL: url,
                DATABASE_ROLE: 'service_role',
                STORAGE_PROVIDER: 'memory',
                DATABASE_POOL_MAX: '2'
            } as unknown as NodeJS.ProcessEnv);
        const first = createApp(env(database.url));
        const second = createApp(env(database.url));
        onTestFinished(async () => {
            await first.persistence.close();
            await second.persistence.close();
            await database.drop();
        });
        await seedReferenceData(first);
        const a = await actors(first);
        const { txId } = await toInProgress(first, a.seller, a.buyer);
        const m = await submitMilestone(first, a.seller, txId, 0);
        await first.milestones.review(a.buyer, txId, m, { decision: 'APPROVE' });
        await payAllSubmitted(first);

        const log = await second.admin.auditLog(a.auditor);
        expect(log.events.length).toBeGreaterThan(20);
        expect(log.chain).toEqual({ valid: true, length: log.events.length });
        expect(log.events.some((e) => e.actorType === 'SYSTEM' && e.actorId === 'system')).toBe(true);
        expect(log.events.some((e) => e.actorType === 'PROVIDER' && e.actorId === 'mock')).toBe(true);
        expect((await second.admin.overview(a.auditor)).trialBalance.every((t) => t.balanced)).toBe(true);
    });

    it('seeds only the first boot of an empty database, never in production, and refuses a demo reset', async () => {
        const { seedIfEmpty, resetDemo } = await import('@/server/instance');
        const database = await createTestDatabase();
        const config = loadConfig({
            TRUSTCARGO_MODE: 'demo',
            SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
            MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
            DATABASE_URL: database.url,
            DATABASE_ROLE: 'service_role',
            STORAGE_PROVIDER: 'memory'
        } as unknown as NodeJS.ProcessEnv);
        const apps = [createApp(config), createApp(config), createApp({ ...config, mode: 'production' })];
        const global = globalThis as unknown as { __trustcargo?: Promise<unknown> };
        onTestFinished(async () => {
            delete global.__trustcargo;
            for (const app of apps) await app.persistence.close();
            await database.drop();
        });
        expect(await seedIfEmpty(apps[2]!)).toBe(false);
        expect(await apps[2]!.deps.uow.run((db) => db.users.list())).toEqual([]);
        expect(await seedIfEmpty(apps[0]!)).toBe(true);
        const users = await apps[0]!.deps.uow.run((db) => db.users.list());
        expect(users.length).toBeGreaterThan(5);
        expect(users.every((u) => u.isDemo)).toBe(true);
        // A restart (new process, same database) keeps the data and does not seed again.
        expect(await seedIfEmpty(apps[1]!)).toBe(false);
        expect(await apps[1]!.deps.uow.run((db) => db.users.list())).toHaveLength(users.length);
        expect((await apps[1]!.deps.uow.run((db) => db.transactions.list())).length).toBe(5);

        global.__trustcargo = Promise.resolve(apps[1]);
        await expect(resetDemo()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(await apps[1]!.deps.uow.run((db) => db.users.list())).toHaveLength(users.length);
    });

    it('serialises units of work across pools: concurrent read-modify-write loses no update', async () => {
        const { database, uow } = await openDatabase();
        const other = new PostgresDatabase({ url: database.url, role: 'service_role', poolMax: 3 });
        onTestFinished(() => other.close());
        const rows = graph('ser', false);
        await uow.run((db) => insertAll(db, rows));
        const user = rows.find(([t]) => t === 'users')![1].id;
        const counter = id();
        await uow.run((db) =>
            db.notifications.insert({ id: counter, userId: user, type: 'counter', params: { n: '0' }, createdAt: at(1) })
        );
        const increment = (p: PostgresDatabase) =>
            p.run(async (db) => {
                const n = Number((await db.notifications.get(counter))!.params.n);
                await new Promise((resolve) => setTimeout(resolve, 2));
                await db.notifications.update(counter, { params: { n: String(n + 1) } });
            });
        await Promise.all(Array.from({ length: 20 }, (_, i) => increment(i % 2 ? uow : other)));
        expect((await uow.run((db) => db.notifications.get(counter)))!.params.n).toBe('20');
    });

    it(
        'waits for the global lock longer than lock_timeout (10 s): a unit of work queues behind a slow one',
        { timeout: 30_000 },
        async () => {
            const { uow, raw } = await openDatabase();
            // Another unit of work (any instance) holds the global lock for 10.5 s.
            await raw.query('begin');
            await raw.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['trustcargo.unit_of_work']);
            const started = Date.now();
            const queued = uow
                .run((db) => db.users.list())
                .then(
                    (rows) => ({ rows }),
                    (error: { code?: string }) => ({ code: error.code })
                );
            await new Promise((resolve) => setTimeout(resolve, 10_500));
            await raw.query('commit');
            expect(await queued).toEqual({ rows: [] });
            expect(Date.now() - started).toBeGreaterThanOrEqual(10_500);
            expect(DEFAULT_TIMEOUTS).toEqual({ globalLockWaitMs: 30_000, lockTimeoutMs: 10_000, statementTimeoutMs: 20_000 });
        }
    );

    it('reports a busy database (lock wait or statement timeout) as the retryable UNAVAILABLE error, not an internal one', async () => {
        const { database, raw } = await openDatabase();
        const open = (timeouts: Partial<UnitOfWorkTimeouts>) => {
            const db = new PostgresDatabase({ url: database.url, role: 'service_role', poolMax: 2 }, timeouts);
            onTestFinished(() => db.close());
            return db;
        };
        const unavailable = { code: 'UNAVAILABLE', status: 503 };

        // 1. The global lock is still held when its own (bounded) wait ends: 55P03.
        const queued = open({ globalLockWaitMs: 300 });
        await raw.query('begin');
        await raw.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['trustcargo.unit_of_work']);
        await expect(queued.run((db) => db.users.list())).rejects.toMatchObject(unavailable);
        await raw.query('commit');
        expect(await queued.run((db) => db.users.list())).toEqual([]);

        // 2. A row lock inside the unit of work outlasts lock_timeout (55P03) or statement_timeout (57014).
        await raw.query("insert into trustcargo_private.counters (name, value) values ('busy', 1)");
        await raw.query('begin');
        await raw.query("select 1 from trustcargo_private.counters where name = 'busy' for update");
        await expect(open({ lockTimeoutMs: 200 }).run((db) => db.nextSequence('busy'))).rejects.toMatchObject(unavailable);
        await expect(open({ lockTimeoutMs: 5_000, statementTimeoutMs: 200 }).run((db) => db.nextSequence('busy'))).rejects.toMatchObject(
            unavailable
        );
        await raw.query('rollback');
        expect(await queued.run((db) => db.nextSequence('busy'))).toBe(2);
    });

    it('rejects a unit of work whose backend is lost, without any uncaught error, and keeps working', async () => {
        const { database, uow, raw } = await openDatabase();
        const problems = captureProcessErrors();
        let terminated = 0;
        await expect(
            uow.run(async (db) => {
                await db.users.list(); // transaction open, global lock held
                const { rows } = await raw.query(
                    `select pid from pg_stat_activity
                     where datname = $1 and application_name = 'trustcargo-pay' and state = 'idle in transaction'`,
                    [database.name]
                );
                for (const row of rows)
                    terminated += (await raw.query('select pg_terminate_backend($1) as ok', [row.pid])).rows[0].ok ? 1 : 0;
                await new Promise((resolve) => setTimeout(resolve, 300)); // e.g. a failover while the service works
                await db.users.list();
            })
        ).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(terminated).toBe(1);
        expect(problems).toEqual([]);
        expect(await uow.run((db) => db.users.list())).toEqual([]);
    });

    it('grants service_role what the adapter needs, and nothing to anon / authenticated on private tables', async () => {
        const { raw } = await openDatabase();
        const privileges = async (role: string, table: string, privilege: string) =>
            (await raw.query('select has_table_privilege($1, $2, $3) as ok', [role, table, privilege])).rows[0].ok as boolean;
        for (const spec of Object.values(TABLES)) {
            for (const p of ['SELECT', 'INSERT', ...(spec.appendOnly ? [] : ['UPDATE'])])
                expect([spec.table, p, await privileges('service_role', spec.table, p)]).toEqual([spec.table, p, true]);
        }
        for (const table of [
            'trustcargo.user_platform_roles',
            'trustcargo.reconciliation_items',
            'trustcargo_private.counters',
            'trustcargo_private.demo_mfa_secrets'
        ]) {
            for (const p of ['SELECT', 'INSERT']) expect([table, p, await privileges('service_role', table, p)]).toEqual([table, p, true]);
            if (table.startsWith('trustcargo_private'))
                for (const role of ['anon', 'authenticated'])
                    expect([table, role, await privileges(role, table, 'SELECT')]).toEqual([table, role, false]);
        }
        expect((await raw.query("select rolsuper, rolbypassrls from pg_roles where rolname = 'service_role'")).rows[0]).toEqual({
            rolsuper: false,
            rolbypassrls: true
        });
    });

    it('mirrors the TypeScript state machines and vocabularies in SQL', async () => {
        const { raw } = await openDatabase();
        const sqlAllows = async (fn: string, args: string[]) =>
            (await raw.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as ok`, args)).rows[0].ok as boolean;

        const tsAllows = (from: M.TransactionStatus, to: M.TransactionStatus) =>
            (Object.keys(TRANSITIONS) as TransitionId[]).map(getTransition).some((t) => t.from.includes(from) && t.targets.includes(to));
        for (const from of TRANSACTION_STATUSES)
            for (const to of TRANSACTION_STATUSES) {
                if (from === to) continue;
                expect([from, to, await sqlAllows('trustcargo_private.transaction_transition_allowed', [from, to])]).toEqual([
                    from,
                    to,
                    tsAllows(from, to)
                ]);
            }

        const payout: M.PayoutStatus[] = ['REQUESTED', 'SUBMITTED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'];
        const refund: M.RefundStatus[] = ['REQUESTED', 'SUBMITTED', 'PROCESSING', 'REFUNDED', 'FAILED', 'CANCELLED'];
        for (const from of payout)
            for (const to of payout)
                if (from !== to)
                    expect([from, to, await sqlAllows('trustcargo_private.settlement_transition_allowed', ['payouts', from, to])]).toEqual([
                        from,
                        to,
                        canMovePayout(from, to)
                    ]);
        for (const from of refund)
            for (const to of refund)
                if (from !== to)
                    expect([from, to, await sqlAllows('trustcargo_private.settlement_transition_allowed', ['refunds', from, to])]).toEqual([
                        from,
                        to,
                        canMoveRefund(from, to)
                    ]);

        const labels = async (type: string) =>
            (
                await raw.query(
                    'select array_agg(enumlabel::text order by enumsortorder) as l from pg_enum where enumtypid = $1::regtype',
                    [type]
                )
            ).rows[0].l as string[];
        expect(await labels('trustcargo.transaction_status')).toEqual([...TRANSACTION_STATUSES]);
        expect(await labels('trustcargo.document_type')).toEqual([...DOCUMENT_TYPES]);
        expect(await labels('trustcargo.platform_role')).toEqual([...PLATFORM_ROLES]);
        expect((await raw.query('select trustcargo_private.try_uuid($1) as u', [gen.id()])).rows[0].u).toMatch(/^[0-9a-f-]{36}$/);
    });
});
