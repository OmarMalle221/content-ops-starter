'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, KeyRound, Pause, Play, Trash2 } from 'lucide-react';
import { Button, Label, Select } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { FormMessage } from '@/components/form-message';
import { StatusBadge } from '@/components/status-badge';
import { SecretRevealDialog } from './secret-reveal-dialog';
import type { Webhook, WebhookDelivery } from './types';

/** Enable / disable, rotate secret, send test and delete — driven by the server-computed `nextActions`. */
export function WebhookActions({ webhook, events }: { webhook: Webhook; events: string[] }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [testEvent, setTestEvent] = useState(webhook.events[0] ?? events[0] ?? 'transaction.created');
  const [testResult, setTestResult] = useState<WebhookDelivery | null>(null);
  const has = (a: string) => webhook.nextActions.includes(a);
  if (webhook.nextActions.length === 0) return null;

  async function toggle(isActive: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/webhooks/${webhook.id}`, { method: 'PATCH', json: { isActive } });
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-1">
        {has('ENABLE') ? (
          <Button variant="outline" size="sm" loading={busy} onClick={() => toggle(true)}>
            <Play /> {t('webhooks.enable')}
          </Button>
        ) : null}
        {has('DISABLE') ? (
          <Button variant="outline" size="sm" loading={busy} onClick={() => toggle(false)}>
            <Pause /> {t('webhooks.disable')}
          </Button>
        ) : null}
        {has('SEND_TEST') ? (
          <ActionDialog
            trigger={
              <Button variant="outline" size="sm">
                <FlaskConical /> {t('webhooks.sendTest')}
              </Button>
            }
            title={t('webhooks.testTitle')}
            description={t('webhooks.testDescription')}
            confirmLabel={t('common.send')}
            onConfirm={async () => {
              let delivery: WebhookDelivery;
              try {
                delivery = await api(`/v1/webhooks/${webhook.id}/test`, {
                  method: 'POST',
                  json: { eventType: testEvent },
                });
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              setTestResult(delivery);
              router.refresh();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={`w-test-${webhook.id}`}>{t('webhooks.testEvent')}</Label>
              <Select
                id={`w-test-${webhook.id}`}
                value={testEvent}
                onChange={(e) => setTestEvent(e.target.value)}
              >
                {events.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
              <p className="truncate font-mono text-xs text-muted-foreground">{webhook.url}</p>
            </div>
          </ActionDialog>
        ) : null}
        {has('ROTATE_SECRET') ? (
          <ActionDialog
            trigger={
              <Button variant="outline" size="sm">
                <KeyRound /> {t('webhooks.rotateSecret')}
              </Button>
            }
            title={t('webhooks.rotateTitle')}
            description={t('webhooks.rotateDescription')}
            confirmLabel={t('webhooks.rotateSecret')}
            onConfirm={async () => {
              let rotated: { webhook: Webhook; secret: string };
              try {
                rotated = await api(`/v1/webhooks/${webhook.id}/rotate-secret`, { method: 'POST' });
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              setRevealed(rotated.secret);
              router.refresh();
            }}
          >
            <p className="truncate font-mono text-xs text-muted-foreground">{webhook.url}</p>
          </ActionDialog>
        ) : null}
        {has('DELETE') ? (
          <ActionDialog
            trigger={
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                <Trash2 /> {t('webhooks.delete')}
              </Button>
            }
            title={t('webhooks.deleteTitle')}
            description={t('webhooks.deleteDescription')}
            confirmLabel={t('webhooks.delete')}
            variant="destructive"
            onConfirm={async () => {
              try {
                await api(`/v1/webhooks/${webhook.id}`, { method: 'DELETE' });
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              router.refresh();
            }}
          >
            <p className="truncate font-mono text-xs text-muted-foreground">{webhook.url}</p>
          </ActionDialog>
        ) : null}
      </div>
      <FormMessage error={error} />
      {testResult ? (
        <p className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            {t('webhooks.testResult')}
            {locale === 'fr' ? ' :' : ':'}
          </span>
          <StatusBadge status={testResult.status} />
          <span className="font-mono">
            {testResult.lastStatusCode ?? '—'}
            {testResult.lastError ? ` · ${testResult.lastError}` : ''}
          </span>
        </p>
      ) : null}
      <SecretRevealDialog
        secret={revealed}
        title={t('webhooks.secretRotated')}
        description={t('webhooks.secretDescription')}
        warning={t('webhooks.secretWarning')}
        onClose={() => setRevealed(null)}
      />
    </div>
  );
}
