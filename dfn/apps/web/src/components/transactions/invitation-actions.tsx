'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

export function InvitationActions({
  token,
  authenticated,
  requiresRegistration,
  canRespond,
  transactionId,
  alreadyAccepted,
}: {
  token: string;
  authenticated: boolean;
  requiresRegistration: boolean;
  canRespond: boolean;
  transactionId?: string;
  alreadyAccepted?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<'accept' | 'decline' | null>(null);

  if (!canRespond) {
    if (alreadyAccepted && authenticated && transactionId) {
      return (
        <Button asChild size="lg">
          <Link href={`/transactions/${transactionId}`}>{t('common.details')}</Link>
        </Button>
      );
    }
    return null;
  }
  if (!authenticated) {
    const target = requiresRegistration
      ? `/register?invitation=${token}&next=${encodeURIComponent(`/invite/${token}`)}`
      : `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
    return (
      <Button asChild size="lg">
        <Link href={target}>{requiresRegistration ? t('auth.register') : t('auth.login')}</Link>
      </Button>
    );
  }
  async function respond(kind: 'accept' | 'decline') {
    setLoading(kind);
    setError(null);
    try {
      const res = await api(`/v1/invitations/${kind}`, { method: 'POST', json: { token } });
      router.push(kind === 'accept' ? `/transactions/${res.id}` : '/transactions');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(null);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={() => respond('accept')} loading={loading === 'accept'}>
          {t('actions.ACCEPT_INVITATION')}
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={() => respond('decline')}
          loading={loading === 'decline'}
        >
          {t('actions.DECLINE_INVITATION')}
        </Button>
      </div>
      <FormMessage error={error} />
    </div>
  );
}
