import Link from 'next/link';
import { ArrowRight, BadgeCheck, Clock, FileWarning, Inbox, Landmark, ShieldCheck } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Stat,
} from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { IdentityVerificationForm } from '@/components/forms/identity-verification-form';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate, formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const [{ t, locale }, session, buyer, seller] = await Promise.all([
    getT(),
    getSession(),
    apiFetch<any>('/v1/transactions?role=BUYER&pageSize=50'),
    apiFetch<any>('/v1/transactions?role=SELLER&pageSize=50'),
  ]);
  const user = session!.user;
  const buyerItems = buyer.items as any[];
  const sellerItems = seller.items as any[];
  const pendingPayments = buyerItems.filter((x) =>
    ['ACCEPTED', 'AWAITING_FUNDING'].includes(x.status),
  ).length;
  const toValidate = buyerItems.reduce((a, x) => a + x.milestoneProgress.submitted, 0);
  const docsToProvide = sellerItems.filter((x) => ['FUNDED', 'IN_PROGRESS'].includes(x.status)).length;
  const incoming = sellerItems.filter((x) => x.status === 'PENDING_ACCEPTANCE').length;
  const recent = [...buyerItems, ...sellerItems]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 8);
  const verified = user.identityVerification.status === 'SIMULATED_PASS';
  const escrow = [...buyerItems, ...sellerItems].filter((x) =>
    ['FUNDED', 'IN_PROGRESS', 'DISPUTED'].includes(x.status),
  );

  return (
    <>
      <PageHeader
        title={`${t('auth.welcome')}, ${user.firstName}`}
        subtitle={t('dashboard.subtitle')}
        actions={
          <Button asChild>
            <Link href="/transactions/new">{t('nav.newTransaction')}</Link>
          </Button>
        }
      />
      {!verified ? (
        <Alert variant="warning" className="mb-6">
          <ShieldCheck className="size-4" />
          <AlertTitle>{t('dashboard.verification')}</AlertTitle>
          <AlertDescription>
            <p className="mb-3 text-muted-foreground">
              {user.identityVerification.status === 'SIMULATED_FAIL'
                ? t('status.SIMULATED_FAIL')
                : t('tx.verif.BUYER_IDENTITY_NOT_VERIFIED')}
            </p>
            <IdentityVerificationForm compact />
          </AlertDescription>
        </Alert>
      ) : (
        <p className="mb-6 inline-flex items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
          <BadgeCheck className="size-4" /> {t('dashboard.verified')}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('dashboard.pendingPayments')}
          value={pendingPayments}
          hint={t('dashboard.asBuyer')}
          icon={<Clock />}
        />
        <Stat
          label={t('dashboard.toValidate')}
          value={toValidate}
          hint={t('dashboard.asBuyer')}
          icon={<FileWarning />}
        />
        <Stat
          label={t('dashboard.docsToProvide')}
          value={docsToProvide}
          hint={t('dashboard.asSeller')}
          icon={<Inbox />}
        />
        <Stat
          label={t('dashboard.incoming')}
          value={incoming}
          hint={t('dashboard.asSeller')}
          icon={<Landmark />}
        />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{t('dashboard.recent')}</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/transactions">
                {t('common.seeAll')} <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <EmptyState
                title={t('dashboard.noTransactions')}
                description={t('dashboard.createFirst')}
                action={
                  <Button asChild>
                    <Link href="/transactions/new">{t('nav.newTransaction')}</Link>
                  </Button>
                }
              />
            ) : (
              <ul className="divide-y">
                {recent.map((x) => (
                  <li key={x.id}>
                    <Link
                      href={`/transactions/${x.id}`}
                      className="flex items-center justify-between gap-3 py-3 hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{x.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {x.reference} · {t(`roles.${x.myRole}`)} · {formatDate(x.updatedAt, locale)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-medium tabular-nums">
                          {formatMoney(x.amount, locale)}
                        </span>
                        <StatusBadge status={x.status} />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.escrowHeld')}</CardTitle>
          </CardHeader>
          <CardContent>
            {escrow.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('common.empty')}</p>
            ) : (
              <ul className="space-y-2">
                {escrow.map((x) => (
                  <li key={x.id} className="flex items-center justify-between text-sm">
                    <Link href={`/transactions/${x.id}`} className="truncate font-medium hover:underline">
                      {x.reference}
                    </Link>
                    <span className="tabular-nums">{formatMoney(x.amount, locale)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-muted-foreground">{t('app.sandbox')}</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
