import { notFound } from 'next/navigation';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { Logo } from '@/components/logo';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { StatusBadge } from '@/components/status-badge';
import { InvitationActions } from '@/components/transactions/invitation-actions';
import { apiFetchOptional, getSession } from '@/lib/api-server';
import { formatMoney } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Invitation' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [{ t, locale }, invitation, session] = await Promise.all([
    getT(),
    apiFetchOptional<any>(`/v1/invitations/${token}`),
    getSession(),
  ]);
  if (!invitation) notFound();
  const canRespond =
    invitation.partyStatus === 'INVITED' &&
    !invitation.expired &&
    invitation.transactionStatus === 'PENDING_ACCEPTANCE';
  return (
    <main className="container flex min-h-[calc(100vh-2rem)] flex-col">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <LocaleSwitcher />
      </header>
      <div className="mx-auto w-full max-w-2xl flex-1 py-10">
        <Card className="animate-fade-in">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <Badge variant="sandbox">{t('app.sandbox')}</Badge>
              <StatusBadge status={invitation.transactionStatus} />
            </div>
            <CardTitle className="pt-2 text-2xl">{invitation.title}</CardTitle>
            <CardDescription>
              {invitation.reference} · {invitation.buyer?.name} ({invitation.originCountry} →{' '}
              {invitation.destinationCountry})
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-sm leading-relaxed">{invitation.description}</p>
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t('common.amount')}
                </dt>
                <dd className="text-xl font-semibold">{formatMoney(invitation.amount, locale)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t('tx.seller')}</dt>
                <dd className="text-sm">{invitation.invitedEmail}</dd>
              </div>
            </dl>
            <div>
              <h3 className="mb-2 text-sm font-semibold">{t('tx.milestones')}</h3>
              <ol className="space-y-1 text-sm">
                {invitation.milestones.map((m: any) => (
                  <li key={m.sequence} className="flex justify-between rounded-md border px-3 py-2">
                    <span>
                      {m.sequence}. {m.title}
                    </span>
                    <span className="font-medium tabular-nums">
                      {m.amount} {invitation.amount.currency}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <InvitationActions
              token={token}
              authenticated={Boolean(session && !session.mfaRequired)}
              requiresRegistration={invitation.requiresRegistration}
              canRespond={canRespond}
              transactionId={invitation.transactionId}
              alreadyAccepted={invitation.partyStatus === 'ACCEPTED'}
            />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
