import Link from 'next/link';
import { ArrowRight, Inbox, Plus, ShieldCheck, UserCheck } from 'lucide-react';
import { redirect } from 'next/navigation';
import { acceptInvitationForPartyAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { EmptyState, PageHeader, Stat } from '@/components/app/layout-bits';
import { TransactionStatusBadge } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney, money } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { fmtDate, fmtMoney } from '@/lib/format';
import { nextActionFor } from '@/lib/next-action';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export const metadata = { title: 'Tableau de bord' };

export default async function DashboardPage() {
    const actor = await requireActor();
    if (actor.platformRoles.length) redirect('/admin');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const user = (await app.deps.uow.run((db) => db.users.get(actor.userId)))!;
    const list = await app.transactions.listForActor(actor);
    const views = await Promise.all(list.map((x) => app.views.transaction(actor, x.transaction.id)));
    const invitations = await app.transactions.pendingInvitations(actor);
    const todo = views.map((v) => ({ v, next: nextActionFor(v) })).filter((x) => x.next.mine);
    const active = list.filter((x) => !['COMPLETED', 'CANCELLED', 'REFUNDED', 'DRAFT'].includes(x.transaction.status)).length;
    const completed = list.filter((x) => x.transaction.status === 'COMPLETED');
    const volumeCad = completed
        .filter((x) => x.transaction.amount.currency === 'CAD')
        .reduce((a, x) => a + x.transaction.amount.amountMinor, 0n);

    return (
        <>
            <PageHeader
                title={t('dashboard.greeting', { name: user.fullName.split(' ')[0]! })}
                description={t('dashboard.subtitle')}
                actions={
                    <Button asChild>
                        <Link href="/transactions/new">
                            <Plus aria-hidden /> {t('nav.newTransaction')}
                        </Link>
                    </Button>
                }
            />
            {user.kycStatus !== 'VERIFIED' && (
                <Alert tone="warning" title={t('dashboard.kycBanner')} className="mb-6">
                    <Link href="/verification" className="inline-flex items-center gap-1 font-medium underline">
                        <UserCheck className="size-4" aria-hidden /> {t('dashboard.kycCta')}
                    </Link>
                </Alert>
            )}
            <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label={t('dashboard.statsActive')} value={active} />
                <Stat label={t('dashboard.statsCompleted')} value={completed.length} />
                <Stat label={t('dashboard.statsVolume')} value={formatMoney(money(volumeCad, 'CAD'), intl)} />
                <Stat label={t('dashboard.statsDisputes')} value={list.filter((x) => x.transaction.status === 'DISPUTED').length} />
            </div>

            {invitations.length > 0 && (
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle>{t('dashboard.invitations')}</CardTitle>
                    </CardHeader>
                    <CardContent className="divide-y p-0">
                        {invitations.map((inv) => (
                            <div key={inv.partyId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-sm font-medium">
                                        {inv.title} · <span className="text-muted-foreground">{inv.reference}</span>
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                        {t('invite.from', { seller: inv.sellerName, role: t(`partyRole.${inv.role}`) })} —{' '}
                                        {fmtMoney(inv.amount, intl)}
                                    </p>
                                </div>
                                <ActionForm action={acceptInvitationForPartyAction} successMessage={t('common.success')}>
                                    <input type="hidden" name="partyId" value={inv.partyId} />
                                    <SubmitButton size="sm">{t('dashboard.acceptInvitation')}</SubmitButton>
                                </ActionForm>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}

            <div className="grid gap-6 lg:grid-cols-5">
                <Card className="lg:col-span-2">
                    <CardHeader>
                        <CardTitle>{t('dashboard.needsAction')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {todo.length === 0 ? (
                            <EmptyState icon={ShieldCheck} title={t('dashboard.nothingToDo')} />
                        ) : (
                            todo.map(({ v, next }) => (
                                <Link
                                    key={v.id}
                                    href={`/transactions/${v.id}?tab=${next.tab}`}
                                    className="group flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 hover:border-primary/40 hover:bg-primary-soft/40"
                                >
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium">{t(`nextAction.${next.key}`)}</span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {v.title} · {v.reference}
                                        </span>
                                    </span>
                                    <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden />
                                </Link>
                            ))
                        )}
                    </CardContent>
                </Card>
                <Card className="lg:col-span-3">
                    <CardHeader>
                        <CardTitle>{t('dashboard.recent')}</CardTitle>
                        <Link href="/transactions" className="text-sm font-medium text-primary hover:underline">
                            {t('nav.transactions')} →
                        </Link>
                    </CardHeader>
                    <CardContent className="p-0">
                        {list.length === 0 ? (
                            <div className="p-5">
                                <EmptyState icon={Inbox} title={t('tx.listEmpty')}>
                                    <Link href="/transactions/new" className="font-medium text-primary underline">
                                        {t('tx.listEmptyCta')}
                                    </Link>
                                </EmptyState>
                            </div>
                        ) : (
                            <ul className="divide-y">
                                {list.slice(0, 6).map(({ transaction: tx, counterpartyName, myRole }) => (
                                    <li key={tx.id}>
                                        <Link
                                            href={`/transactions/${tx.id}`}
                                            className="flex flex-col gap-1 px-5 py-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
                                        >
                                            <span className="min-w-0">
                                                <span className="block truncate text-sm font-medium">{tx.title}</span>
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {tx.reference} · {myRole ? t(`partyRole.${myRole}`) : ''} · {counterpartyName} ·{' '}
                                                    {fmtDate(tx.updatedAt, intl)}
                                                </span>
                                            </span>
                                            <span className="flex items-center gap-3">
                                                <span className="text-sm font-medium tabular">{formatMoney(tx.amount, intl)}</span>
                                                <TransactionStatusBadge status={tx.status} label={t(`status.${tx.status}`)} />
                                            </span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </div>
        </>
    );
}
