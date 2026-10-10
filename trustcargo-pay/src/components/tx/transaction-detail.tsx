import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/app/layout-bits';
import { TransactionStatusBadge } from '@/components/app/status';
import { formatMoney, fromDTO } from '@/domain/money';
import { TRANSACTION_STATUSES } from '@/domain/model';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { cn } from '@/lib/cn';
import { CancelTransaction } from './cancel-transaction';
import { ContractTab } from './contract-tab';
import { DisputesTab } from './disputes-tab';
import { DocumentsTab } from './documents-tab';
import { HistoryTab } from './history-tab';
import { MilestonesTab } from './milestones-tab';
import { OverviewTab } from './overview-tab';
import { PaymentsTab } from './payments-tab';
import { RiskTab } from './risk-tab';
import { TransactionStepper } from './stepper';

export const TABS = ['overview', 'contract', 'milestones', 'documents', 'payments', 'disputes', 'risk', 'history'] as const;
export type Tab = (typeof TABS)[number];

export function TransactionDetail({
    view,
    t,
    intl,
    basePath,
    tab,
    staffActions,
    riskReviewPanel,
    disputeStaffPanel
}: {
    view: TransactionView;
    t: Translator;
    intl: string;
    basePath: string;
    tab: Tab;
    staffActions?: React.ReactNode;
    riskReviewPanel?: (alertId: string) => React.ReactNode;
    disputeStaffPanel?: (disputeId: string) => React.ReactNode;
}) {
    const tabs = TABS.filter((x) =>
        x === 'payments'
            ? view.can.viewPayments
            : x === 'risk'
              ? view.can.viewRisk
              : x === 'disputes'
                ? view.disputes.length > 0 || view.can.openDispute || view.can.viewRisk
                : true
    );
    const current = tabs.includes(tab) ? tab : 'overview';
    const labels = Object.fromEntries(TRANSACTION_STATUSES.map((s) => [s, t(`status.${s}`)]));
    return (
        <>
            <PageHeader
                eyebrow={
                    <span className="font-mono">
                        {view.reference} · {view.corridorCode}
                    </span>
                }
                title={
                    <span className="flex flex-wrap items-center gap-3">
                        {view.title}
                        <TransactionStatusBadge status={view.status} label={t(`status.${view.status}`)} />
                    </span>
                }
                description={
                    <span className="text-base font-medium text-foreground tabular">{formatMoney(fromDTO(view.amount), intl)}</span>
                }
                actions={
                    <>
                        {staffActions}
                        {view.can.cancel && <CancelTransaction transactionId={view.id} />}
                    </>
                }
            />
            <div className="mb-6 space-y-3">
                <TransactionStepper status={view.status} labels={labels} />
                {view.viewer.viaOrganization && <Alert tone="info">{t('tx.orgReadOnly')}</Alert>}
                {view.viewer.staff && <Alert tone="info">{t('tx.staffReadOnly')}</Alert>}
                {view.blockedReasons
                    .filter((b) => b !== 'DISPUTE_OPEN')
                    .map((b) => (
                        <Alert key={b} tone="warning">
                            {t(`blocker.${b}`)}
                        </Alert>
                    ))}
                {view.status === 'CANCELLED' && view.cancellationReason && (
                    <Alert tone="info" title={t('status.CANCELLED')}>
                        {view.cancellationReason}
                    </Alert>
                )}
            </div>
            <nav aria-label="Sections" className="mb-6 -mx-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
                <ul className="flex min-w-max gap-1">
                    {tabs.map((x) => (
                        <li key={x}>
                            <Link
                                href={`${basePath}?tab=${x}`}
                                scroll={false}
                                aria-current={x === current ? 'page' : undefined}
                                className={cn(
                                    '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                                    x === current
                                        ? 'border-primary text-primary'
                                        : 'border-transparent text-muted-foreground hover:text-foreground'
                                )}
                            >
                                {t(`tx.tabs.${x}`)}
                                {x === 'disputes' &&
                                    view.disputes.some((d) => ['AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(d.status)) && (
                                        <span className="size-1.5 rounded-full bg-danger" aria-hidden />
                                    )}
                                {x === 'risk' && (view.risk ?? []).some((a) => a.status === 'OPEN') && (
                                    <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                                )}
                            </Link>
                        </li>
                    ))}
                </ul>
            </nav>
            {current === 'overview' && <OverviewTab view={view} t={t} intl={intl} basePath={basePath} />}
            {current === 'contract' && <ContractTab view={view} t={t} intl={intl} />}
            {current === 'milestones' && <MilestonesTab view={view} t={t} intl={intl} />}
            {current === 'documents' && <DocumentsTab view={view} t={t} intl={intl} />}
            {current === 'payments' && <PaymentsTab view={view} t={t} intl={intl} />}
            {current === 'disputes' && <DisputesTab view={view} t={t} intl={intl} staffPanel={disputeStaffPanel} />}
            {current === 'risk' && <RiskTab view={view} t={t} intl={intl} reviewPanel={riskReviewPanel} />}
            {current === 'history' && <HistoryTab view={view} t={t} intl={intl} />}
        </>
    );
}
