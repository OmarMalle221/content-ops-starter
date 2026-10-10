/**
 * Composition root: wires ports to adapters and services together.
 * Swapping the in-memory database or the mock providers for real adapters happens here only.
 */
import { MockPaymentProvider } from './adapters/mock/mock-payment-provider';
import { EicarOnlyScanner, MockIdentityProvider, MockScreeningProvider, SystemClock, UuidGenerator } from './adapters/mock/mock-providers';
import { createPersistence } from './adapters/persistence';
import { createFileStorage } from './adapters/storage';
import type { ServerConfig } from './config';
import { InMemoryRateLimiter } from './security/rate-limit';
import { AdminService, ComplianceService, NotificationService, ReconciliationService } from './services/admin-services';
import type { Deps } from './services/context';
import { DisputeService } from './services/dispute-service';
import { DocumentService } from './services/document-service';
import { IdentityService } from './services/identity-service';
import { LedgerService } from './services/ledger-service';
import { MilestoneService } from './services/milestone-service';
import { PaymentAccountService } from './services/payment-account-service';
import { PaymentService } from './services/payment-service';
import { ProviderEventService } from './services/provider-event-service';
import { RiskService } from './services/risk-service';
import { TransactionService } from './services/transaction-service';
import { ViewService } from './services/view-service';
import { Workflow } from './services/workflow';

export function createApp(config: ServerConfig) {
    const persistence = createPersistence(config);
    const clock = new SystemClock();
    const mockProvider = new MockPaymentProvider(config.webhookSecret, clock);
    const deps: Deps = {
        uow: persistence.uow,
        clock,
        ids: new UuidGenerator(),
        payments: mockProvider,
        identity: new MockIdentityProvider(),
        screening: new MockScreeningProvider(),
        storage: createFileStorage(config),
        scanner: new EicarOnlyScanner(),
        config: { mode: config.mode, sessionSecret: config.sessionSecret, appUrl: config.appUrl }
    };

    const ledger = new LedgerService(deps);
    const workflow = new Workflow(deps, ledger);
    const risk = new RiskService(deps);
    const payments = new PaymentService(deps, ledger, risk);
    const transactions = new TransactionService(deps, workflow);
    transactions.risk = risk;
    const identity = new IdentityService(deps, workflow, risk);
    const paymentAccounts = new PaymentAccountService(deps, risk);
    const documents = new DocumentService(deps, risk);
    const milestones = new MilestoneService(deps, workflow, payments);
    documents.attachEvidence = (db, actor, txId, milestoneId, docId) => milestones.attachEvidenceInTx(db, actor, txId, milestoneId, docId);
    const disputes = new DisputeService(deps, workflow, payments);
    const providerEvents = new ProviderEventService(deps, workflow, ledger, payments);
    providerEvents.onSettlementProgress = (db, txId) => disputes.onSettlementProgress(db, txId);
    risk.onAlertsCleared = async (txId) => {
        await payments.retryBlockedReleases({ kind: 'SYSTEM', id: 'system' }, txId);
    };
    mockProvider.setDelivery((raw, header) => providerEvents.ingest(raw, header));

    return {
        config,
        deps,
        persistence,
        clock,
        mockProvider,
        rateLimiter: new InMemoryRateLimiter(),
        ledger,
        workflow,
        risk,
        payments,
        transactions,
        identity,
        paymentAccounts,
        documents,
        milestones,
        disputes,
        providerEvents,
        compliance: new ComplianceService(deps, payments),
        reconciliation: new ReconciliationService(deps, ledger),
        admin: new AdminService(deps, ledger),
        notifications: new NotificationService(deps),
        views: new ViewService(deps, workflow, documents, payments, risk, mockProvider)
    };
}

export type App = ReturnType<typeof createApp>;
