import { DisputeStaffPanel, LiftHold, PlaceHold, RetryReleases, RiskReviewForm } from '@/components/admin/forms';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TABS, TransactionDetail, type Tab } from '@/components/tx/transaction-detail';
import { formatMoney, fromDTO, money } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { loadTransactionView } from '@/server/load-view';
import { TX_READERS } from '@/server/staff';

export default async function AdminTransaction({
    params,
    searchParams
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ tab?: string }>;
}) {
    const { id } = await params;
    const { tab } = await searchParams;
    const actor = await requireStaff(TX_READERS, `/admin/transactions/${id}`);
    const { t, intl } = await getI18n();
    const current = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'overview';
    const view = await loadTransactionView(actor, id, current === 'documents');
    const compliance = hasRole(actor, 'compliance_analyst');
    const disputes = hasRole(actor, 'dispute_manager');
    const finance = hasRole(actor, 'finance_operator');
    const held = view.payment ? formatMoney(money(BigInt(view.payment.heldMinor), fromDTO(view.amount).currency), intl) : '—';
    return (
        <>
            <TransactionDetail
                view={view}
                t={t}
                intl={intl}
                basePath={`/admin/transactions/${id}`}
                tab={current}
                staffActions={
                    <>
                        {(compliance || finance) && <RetryReleases transactionId={id} />}
                        {compliance && <PlaceHold transactionId={id} />}
                    </>
                }
                riskReviewPanel={compliance ? (alertId) => <RiskReviewForm alertId={alertId} transactionId={id} /> : undefined}
                disputeStaffPanel={
                    disputes
                        ? (disputeId) => (
                              <DisputeStaffPanel
                                  disputeId={disputeId}
                                  transactionId={id}
                                  status={view.disputes.find((d) => d.id === disputeId)!.status}
                                  heldLabel={held}
                              />
                          )
                        : undefined
                }
            />
            {view.holds && view.holds.length > 0 && (
                <Card className="mt-6">
                    <CardHeader>
                        <CardTitle>{t('risk.holds')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {view.holds.map((h) => (
                            <div
                                key={h.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                            >
                                <span>
                                    {t(`risk.holdType.${h.type}`)} · <span className="font-mono text-xs">{h.reference}</span> ·{' '}
                                    {fmtDate(h.placedAt, intl, true)}
                                </span>
                                <span className="flex items-center gap-2">
                                    <ToneBadge tone={h.status === 'ACTIVE' ? 'danger' : toneFor(h.status)}>{h.status}</ToneBadge>
                                    {h.status === 'ACTIVE' && compliance && <LiftHold holdId={h.id} transactionId={id} />}
                                </span>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}
        </>
    );
}
