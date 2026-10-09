import { ReverseJournal, RunReconciliation } from '@/components/admin/forms';
import { PageHeader, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatMoney, money } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function LedgerPage() {
    const actor = await requireStaff(['finance_operator', 'auditor'], '/admin/ledger');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const ledger = await app.admin.ledgerView(actor);
    const recs = await app.reconciliation.list(actor);
    const finance = hasRole(actor, 'finance_operator');
    const accountsById = new Map(ledger.balances.map((b) => [b.account.id, b.account]));
    const reversed = new Set(ledger.journals.filter((j) => j.reversesJournalId).map((j) => j.reversesJournalId));
    return (
        <>
            <PageHeader title={t('nav.ledger')} actions={finance ? <RunReconciliation demo={app.config.mode === 'demo'} /> : undefined} />
            <Alert tone="info" className="mb-6">
                {t('tx.fundsHeldHint')} {t('app.notABank')}
            </Alert>
            <div className="space-y-6">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.reconciliations')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {recs.length === 0 && <p className="text-sm text-muted-foreground">{t('common.none')}</p>}
                        {recs.slice(0, 3).map((r) => (
                            <details key={r.id} className="rounded-md border" open={r === recs[0]}>
                                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm">
                                    <span>{fmtDate(r.runAt, intl, true)}</span>
                                    <ToneBadge tone={toneFor(r.status)}>{r.status}</ToneBadge>
                                </summary>
                                <Table>
                                    <TBody>
                                        {r.items.map((i) => (
                                            <TR key={i.externalReference + i.kind}>
                                                <TD>
                                                    <Mono>{i.externalReference}</Mono>
                                                </TD>
                                                <TD className="text-xs">{i.kind}</TD>
                                                <TD className="text-right font-mono text-xs">{i.providerAmountMinor ?? '—'}</TD>
                                                <TD className="text-right font-mono text-xs">{i.ledgerAmountMinor ?? '—'}</TD>
                                                <TD>
                                                    <ToneBadge tone={i.result === 'MATCHED' ? 'success' : 'danger'}>{i.result}</ToneBadge>
                                                </TD>
                                            </TR>
                                        ))}
                                    </TBody>
                                </Table>
                            </details>
                        ))}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.accounts')}</CardTitle>
                    </CardHeader>
                    <Table>
                        <THead>
                            <tr>
                                <TH>Code</TH>
                                <TH>Type</TH>
                                <TH className="text-right">Solde</TH>
                            </tr>
                        </THead>
                        <TBody>
                            {ledger.balances.map(({ account: a, balanceMinor }) => (
                                <TR key={a.id}>
                                    <TD>
                                        <Mono>{a.code}</Mono>
                                        <p className="text-xs text-muted-foreground">{a.name}</p>
                                    </TD>
                                    <TD className="text-xs">{a.type}</TD>
                                    <TD className="text-right tabular">{formatMoney(money(BigInt(balanceMinor), a.currency), intl)}</TD>
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.journals')}</CardTitle>
                    </CardHeader>
                    <Table>
                        <THead>
                            <tr>
                                <TH>{t('common.date')}</TH>
                                <TH>Type</TH>
                                <TH>Écritures</TH>
                                <TH />
                            </tr>
                        </THead>
                        <TBody>
                            {ledger.journals.map((j) => (
                                <TR key={j.id}>
                                    <TD className="text-xs whitespace-nowrap">{fmtDate(j.postedAt, intl, true)}</TD>
                                    <TD>
                                        <ToneBadge tone={j.kind === 'REVERSAL' ? 'warning' : 'neutral'}>{j.kind}</ToneBadge>
                                        <p className="mt-1 text-xs text-muted-foreground">{j.description}</p>
                                        <Mono className="text-[10px] text-muted-foreground">{j.idempotencyKey}</Mono>
                                    </TD>
                                    <TD className="text-xs">
                                        {ledger.entries
                                            .filter((e) => e.journalId === j.id)
                                            .map((e) => (
                                                <p key={e.id} className="font-mono">
                                                    {e.direction === 'DEBIT' ? 'Dr' : 'Cr'}{' '}
                                                    {accountsById.get(e.accountId)?.code.split(':')[0]} {e.amountMinor.toString()}
                                                </p>
                                            ))}
                                    </TD>
                                    <TD>
                                        {finance && j.kind !== 'REVERSAL' && !reversed.has(j.id) && <ReverseJournal journalId={j.id} />}
                                    </TD>
                                </TR>
                            ))}
                        </TBody>
                    </Table>
                </Card>
            </div>
        </>
    );
}
