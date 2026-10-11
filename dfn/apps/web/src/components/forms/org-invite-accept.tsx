'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

export function OrgInviteAccept({ token }: { token: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <div className="space-y-3">
      <Button
        size="lg"
        loading={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            await api('/v1/organizations/invitations/accept', { method: 'POST', json: { token } });
            // Memberships are cached in the session: re-login refreshes them.
            await api('/v1/auth/logout', { method: 'POST' });
            router.push('/login?next=/business');
            router.refresh();
          } catch (e) {
            setError(errorMessage(e));
            setLoading(false);
          }
        }}
      >
        {t('actions.ACCEPT_INVITATION')}
      </Button>
      <FormMessage error={error} />
    </div>
  );
}
