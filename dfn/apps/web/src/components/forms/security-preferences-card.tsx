'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

interface Prefs {
  requireMfaForTransfers: boolean;
  transferAlerts: boolean;
  dailyTransferLimit: string;
}

const AMOUNT_RE = /^\d{1,13}([.,]\d{1,2})?$/;

function fromJson(raw: Record<string, unknown> | null): Prefs {
  return {
    requireMfaForTransfers:
      typeof raw?.requireMfaForTransfers === 'boolean' ? raw.requireMfaForTransfers : true,
    transferAlerts: typeof raw?.transferAlerts === 'boolean' ? raw.transferAlerts : true,
    dailyTransferLimit: typeof raw?.dailyTransferLimit === 'string' ? raw.dailyTransferLimit : '',
  };
}

/** Security preferences for simulated transfers (MFA step-up, alerts, optional daily limit). */
export function SecurityPreferencesCard({ preferences }: { preferences: Record<string, unknown> | null }) {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<Prefs>(() => fromJson(preferences));
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [loading, setLoading] = useState(false);
  const limitValid = form.dailyTransferLimit.trim() === '' || AMOUNT_RE.test(form.dailyTransferLimit.trim());

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> {t('secprefs.title')}
          </CardTitle>
          <Badge variant="sandbox">{t('common.simulated')}</Badge>
        </div>
        <CardDescription>{t('secprefs.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!limitValid) return;
            setLoading(true);
            setMsg({});
            try {
              const saved = await api('/v1/users/me/security-preferences', {
                method: 'PUT',
                json: {
                  requireMfaForTransfers: form.requireMfaForTransfers,
                  transferAlerts: form.transferAlerts,
                  dailyTransferLimit: form.dailyTransferLimit.trim() ? form.dailyTransferLimit.trim() : null,
                },
              });
              setForm(fromJson(saved));
              setMsg({ success: t('secprefs.saved') });
              router.refresh();
            } catch (err) {
              setMsg({ error: errorMessage(err) });
            } finally {
              setLoading(false);
            }
          }}
        >
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input accent-primary"
              checked={form.requireMfaForTransfers}
              onChange={(e) => setForm((f) => ({ ...f, requireMfaForTransfers: e.target.checked }))}
            />
            <span>
              <span className="font-medium">{t('secprefs.requireMfa')}</span>
              <span className="block text-xs text-muted-foreground">{t('secprefs.requireMfaHint')}</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input accent-primary"
              checked={form.transferAlerts}
              onChange={(e) => setForm((f) => ({ ...f, transferAlerts: e.target.checked }))}
            />
            <span>
              <span className="font-medium">{t('secprefs.alerts')}</span>
              <span className="block text-xs text-muted-foreground">{t('secprefs.alertsHint')}</span>
            </span>
          </label>
          <div className="space-y-2">
            <Label htmlFor="daily-limit">{t('secprefs.dailyLimit')}</Label>
            <Input
              id="daily-limit"
              inputMode="decimal"
              placeholder="2500.00"
              value={form.dailyTransferLimit}
              aria-invalid={!limitValid}
              onChange={(e) => setForm((f) => ({ ...f, dailyTransferLimit: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">{t('secprefs.dailyLimitHint')}</p>
          </div>
          <FormMessage error={msg.error} success={msg.success} />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t('secprefs.defaults')}</p>
            <Button type="submit" loading={loading} disabled={!limitValid}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
