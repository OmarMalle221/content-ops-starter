'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Button, Input, Label } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { Checklist } from './checklist';
import { SecretRevealDialog } from './secret-reveal-dialog';
import type { ApiCredential, ScopeOption } from './types';

const INITIAL = {
  name: '',
  description: '',
  scopes: [] as string[],
  rateLimitPerMinute: '120',
  expiresInDays: '',
};

function intInRange(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function ApiKeyCreateDialog({
  organizationId,
  scopes,
  size,
}: {
  organizationId: string;
  scopes: ScopeOption[];
  size?: 'sm' | 'default';
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState(INITIAL);
  const [revealed, setRevealed] = useState<string | null>(null);
  const set = (patch: Partial<typeof INITIAL>) => setForm((f) => ({ ...f, ...patch }));
  const rate = intInRange(form.rateLimitPerMinute, 10, 1000);
  const expires = form.expiresInDays.trim() === '' ? undefined : intInRange(form.expiresInDays, 1, 365);
  const valid = form.name.trim().length >= 2 && form.scopes.length > 0 && rate !== null && expires !== null;

  return (
    <>
      <ActionDialog
        trigger={
          <Button size={size}>
            <KeyRound /> {t('dev.keys.create')}
          </Button>
        }
        title={t('dev.keys.createTitle')}
        description={t('dev.keys.createDescription')}
        confirmLabel={t('dev.keys.create')}
        disabled={!valid}
        onConfirm={async () => {
          let created: { key: string; credential: ApiCredential };
          try {
            created = await api('/v1/api-credentials', {
              method: 'POST',
              json: {
                organizationId,
                name: form.name.trim(),
                description: form.description.trim() || undefined,
                scopes: form.scopes,
                rateLimitPerMinute: rate,
                expiresInDays: expires,
              },
            });
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          setForm(INITIAL);
          setRevealed(created.key);
          router.refresh();
        }}
      >
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="k-name">{t('dev.keys.name')}</Label>
            <Input
              id="k-name"
              value={form.name}
              placeholder={t('dev.keys.namePlaceholder')}
              maxLength={80}
              onChange={(e) => set({ name: e.target.value })}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="k-description">{t('dev.keys.descriptionField')}</Label>
            <Input
              id="k-description"
              value={form.description}
              maxLength={300}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('dev.keys.scopes')}</Label>
            <Checklist
              idPrefix="k-scope"
              options={scopes.map((s) => ({ value: s.scope, label: s.scope, hint: s.description[locale] }))}
              selected={form.scopes}
              onChange={(next) => set({ scopes: next })}
              selectAllLabel={t('dev.keys.selectAll')}
              clearLabel={t('dev.keys.clearAll')}
            />
            <p className="text-xs text-muted-foreground">{t('dev.keys.scopesHint')}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="k-rate">{t('dev.keys.rateLimit')}</Label>
              <Input
                id="k-rate"
                inputMode="numeric"
                value={form.rateLimitPerMinute}
                aria-invalid={rate === null}
                onChange={(e) => set({ rateLimitPerMinute: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('dev.keys.rateLimitHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="k-expires">{t('dev.keys.expiresIn')}</Label>
              <Input
                id="k-expires"
                inputMode="numeric"
                value={form.expiresInDays}
                placeholder={t('dev.keys.noExpiry')}
                aria-invalid={expires === null}
                onChange={(e) => set({ expiresInDays: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t('dev.keys.expiresHint')}</p>
            </div>
          </div>
        </div>
      </ActionDialog>
      <SecretRevealDialog
        secret={revealed}
        title={t('dev.keys.revealTitle')}
        description={t('dev.keys.revealDescription')}
        warning={t('dev.keys.revealWarning')}
        onClose={() => setRevealed(null)}
      />
    </>
  );
}
