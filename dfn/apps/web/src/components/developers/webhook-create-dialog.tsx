'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Webhook as WebhookIcon } from 'lucide-react';
import { Button, Input, Label } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { Checklist } from './checklist';
import { SecretRevealDialog } from './secret-reveal-dialog';
import type { Webhook } from './types';

const INITIAL = { url: '', description: '', events: [] as string[] };

export function WebhookCreateDialog({
  organizationId,
  events,
  size,
}: {
  organizationId: string;
  events: string[];
  size?: 'sm' | 'default';
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState(INITIAL);
  const [revealed, setRevealed] = useState<string | null>(null);
  const set = (patch: Partial<typeof INITIAL>) => setForm((f) => ({ ...f, ...patch }));
  const urlOk = /^https?:\/\/\S+$/.test(form.url.trim()) && form.url.trim().length <= 500;
  const valid = urlOk && form.events.length > 0;

  return (
    <>
      <ActionDialog
        trigger={
          <Button size={size}>
            <WebhookIcon /> {t('webhooks.create')}
          </Button>
        }
        title={t('webhooks.createTitle')}
        description={t('webhooks.createDescription')}
        confirmLabel={t('webhooks.create')}
        disabled={!valid}
        onConfirm={async () => {
          let created: { webhook: Webhook; secret: string };
          try {
            created = await api('/v1/webhooks', {
              method: 'POST',
              json: {
                organizationId,
                url: form.url.trim(),
                description: form.description.trim() || undefined,
                events: form.events,
              },
            });
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          setForm(INITIAL);
          setRevealed(created.secret);
          router.refresh();
        }}
      >
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="w-url">{t('webhooks.url')}</Label>
            <Input
              id="w-url"
              type="url"
              inputMode="url"
              value={form.url}
              placeholder="https://example.com/webhooks/dfn"
              aria-invalid={form.url.length > 0 && !urlOk}
              onChange={(e) => set({ url: e.target.value })}
              required
            />
            <p className="text-xs text-muted-foreground">{t('webhooks.urlHint')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="w-description">{t('webhooks.descriptionField')}</Label>
            <Input
              id="w-description"
              value={form.description}
              maxLength={300}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('webhooks.events')}</Label>
            <Checklist
              idPrefix="w-event"
              options={events.map((e) => ({ value: e, label: e }))}
              selected={form.events}
              onChange={(next) => set({ events: next })}
              selectAllLabel={t('webhooks.selectAll')}
              clearLabel={t('webhooks.clearAll')}
            />
            <p className="text-xs text-muted-foreground">{t('webhooks.eventsHint')}</p>
          </div>
        </div>
      </ActionDialog>
      <SecretRevealDialog
        secret={revealed}
        title={t('webhooks.secretTitle')}
        description={t('webhooks.secretDescription')}
        warning={t('webhooks.secretWarning')}
        onClose={() => setRevealed(null)}
      />
    </>
  );
}
