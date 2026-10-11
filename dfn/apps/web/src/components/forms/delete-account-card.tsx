'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
} from '@dfn/ui';
import { ClientApiError, api, errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

interface Blockers {
  openTransactions: number;
  soleOwnerOrganizations: number;
  walletsWithBalance: number;
}
interface DeletionStatus {
  deletionRequestedAt: string | null;
  anonymizedAt: string | null;
  anonymizeAfterDays: number;
  anonymizeAfter: string | null;
  blockers: Blockers;
  canRequest: boolean;
}

/**
 * Self-service account deletion: explains the anonymisation delay (from the status endpoint),
 * lists what still blocks the request, then asks for the password and a typed confirmation.
 * On success the session is revoked server-side and the user is sent to /login.
 */
export function DeleteAccountCard({ deletionRequestedAt }: { deletionRequestedAt: string | null }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Explanatory list only — whether the request is allowed comes from `status.canRequest` (API).
  const [blockers, setBlockers] = useState<Blockers | null>(null);
  const [form, setForm] = useState({ password: '', confirmation: '', reason: '' });
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    api<DeletionStatus>('/v1/users/me/deletion-request/status')
      .then((s) => {
        if (!active) return;
        setStatus(s);
        setBlockers(s.blockers);
      })
      .catch((e) => active && setStatusError(errorMessage(e)));
    return () => {
      active = false;
    };
    // Runs once on mount: the status endpoint is the single source of truth for the delay and blockers.
  }, []);

  const requestedAt = status?.deletionRequestedAt ?? deletionRequestedAt;
  const days = status ? String(status.anonymizeAfterDays) : '…';
  const canRequest = status?.canRequest === true;
  const blocked = !!status && !canRequest;
  const canSubmit = canRequest && form.password.length > 0 && form.confirmation === 'DELETE';
  const blockerLines = blockers
    ? [
        [blockers.openTransactions, t('account.blockerTransactions')] as const,
        [blockers.soleOwnerOrganizations, t('account.blockerOrganizations')] as const,
        [blockers.walletsWithBalance, t('account.blockerWallets')] as const,
      ].filter(([count]) => count > 0)
    : [];

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-4" /> {t('account.deleteTitle')}
        </CardTitle>
        <CardDescription>
          {t('account.deleteIntro').replace('{days}', days)} · {t('app.sandbox')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormMessage error={statusError ? `${t('account.statusError')} ${statusError}` : null} />
        {requestedAt ? (
          <div className="rounded-md border bg-muted p-3 text-sm">
            <p>
              <span className="font-medium">{t('account.requestedOn')}</span>{' '}
              {formatDate(requestedAt, locale, true)}
            </p>
            {status?.anonymizeAfter ? (
              <p>
                <span className="font-medium">{t('account.scheduledOn')}</span>{' '}
                {formatDate(status.anonymizeAfter, locale, true)}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">{t('account.pendingHint')}</p>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!canSubmit) return;
              setLoading(true);
              setMsg({});
              try {
                await api('/v1/users/me/deletion-request', {
                  method: 'POST',
                  json: {
                    password: form.password,
                    confirmation: form.confirmation,
                    reason: form.reason.trim() || undefined,
                  },
                });
                setMsg({ success: t('account.loggedOut') });
                window.setTimeout(() => {
                  router.push('/login');
                  router.refresh();
                }, 800);
              } catch (err) {
                if (err instanceof ClientApiError && err.body.code === 'ACCOUNT_HAS_OPEN_ITEMS') {
                  const details = err.body.details as Blockers;
                  setBlockers(details);
                  setStatus((s) => (s ? { ...s, canRequest: false, blockers: details } : s));
                  setMsg({ error: t('account.openItemsError') });
                } else {
                  setMsg({ error: errorMessage(err) });
                }
                setLoading(false);
              }
            }}
          >
            <div className="rounded-md border p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                {t('account.delayLabel')}: {days} {t('jobsAdmin.days')}
              </p>
              {blockerLines.length ? (
                <>
                  <p className="mt-2 font-medium">{t('account.blockersTitle')}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-destructive">
                    {blockerLines.map(([count, label]) => (
                      <li key={label}>
                        <span className="font-semibold">{count}</span> {label}
                      </li>
                    ))}
                  </ul>
                </>
              ) : status ? (
                <p className="mt-2 text-success">{t('account.readyHint')}</p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="delete-password">{t('account.password')}</Label>
                <Input
                  id="delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={form.password}
                  disabled={blocked}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="delete-confirmation">{t('account.confirmation')}</Label>
                <Input
                  id="delete-confirmation"
                  autoComplete="off"
                  placeholder="DELETE"
                  value={form.confirmation}
                  disabled={blocked}
                  onChange={(e) => setForm((f) => ({ ...f, confirmation: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">{t('account.confirmationHint')}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="delete-reason">{t('account.reason')}</Label>
              <Textarea
                id="delete-reason"
                maxLength={500}
                value={form.reason}
                disabled={blocked}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              />
            </div>
            <FormMessage error={msg.error} success={msg.success} />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="destructive" loading={loading} disabled={!canSubmit}>
                {t('account.submit')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('account.irreversible')}</span>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
