'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { LOCALE_COOKIE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { RecoveryCodesDisplay } from '@/components/security/recovery-codes-card';
import { StepUpFields } from '@/components/security/step-up-fields';
import { isMfaCodeInput } from '@/components/security/webauthn-client';

export function ProfileForm({ user }: { user: any }) {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone ?? '',
    locale: user.locale,
  });
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [loading, setLoading] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.profile')}</CardTitle>
        <CardDescription>{user.email}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            setMsg({});
            try {
              await api('/v1/users/me', { method: 'PATCH', json: { ...form, phone: form.phone || null } });
              document.cookie = `${LOCALE_COOKIE}=${form.locale}; path=/; max-age=31536000; samesite=lax`;
              setMsg({ success: '✓' });
              router.refresh();
            } catch (err) {
              setMsg({ error: errorMessage(err) });
            } finally {
              setLoading(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="firstName">{t('auth.firstName')}</Label>
            <Input
              id="firstName"
              value={form.firstName}
              onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lastName">{t('auth.lastName')}</Label>
            <Input
              id="lastName"
              value={form.lastName}
              onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">{t('settings.phone')}</Label>
            <Input
              id="phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="locale">{t('settings.language')}</Label>
            <Select
              id="locale"
              value={form.locale}
              onChange={(e) => setForm((f) => ({ ...f, locale: e.target.value }))}
            >
              <option value="fr">Français</option>
              <option value="en">English</option>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <FormMessage error={msg.error} success={msg.success} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" loading={loading}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PasswordForm() {
  const { t } = useI18n();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [loading, setLoading] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.password')}</CardTitle>
        <CardDescription>{t('auth.passwordHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            setMsg({});
            try {
              await api('/v1/auth/password', { method: 'POST', json: form });
              setForm({ currentPassword: '', newPassword: '' });
              setMsg({ success: '✓' });
            } catch (err) {
              setMsg({ error: errorMessage(err) });
            } finally {
              setLoading(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="currentPassword">{t('settings.currentPassword')}</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">{t('settings.newPassword')}</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
            />
          </div>
          <FormMessage error={msg.error} success={msg.success} />
          <Button
            type="submit"
            loading={loading}
            disabled={!form.currentPassword || form.newPassword.length < 12}
          >
            {t('common.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function MfaCard({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  const [loading, setLoading] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setLoading(true);
    setMsg({});
    try {
      await fn();
      setCode('');
      router.refresh();
    } catch (err) {
      setMsg({ error: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.mfa')}</CardTitle>
        <CardDescription>{enabled ? t('status.ACTIVE') : t('status.NOT_STARTED')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!enabled && !setup ? (
          <Button
            onClick={() => run(async () => setSetup(await api('/v1/auth/mfa/setup', { method: 'POST' })))}
            loading={loading}
          >
            {t('settings.mfaEnable')}
          </Button>
        ) : null}
        {!enabled && setup ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('settings.mfaSetupHint')}</p>
            <code className="block break-all rounded-md border bg-muted p-3 text-xs">{setup.secret}</code>
            <code className="block break-all rounded-md border bg-muted p-3 text-[10px] text-muted-foreground">
              {setup.otpauthUrl}
            </code>
            <div className="flex gap-2">
              <Input
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-40"
              />
              <Button
                loading={loading}
                disabled={code.length !== 6}
                onClick={() =>
                  run(async () => {
                    const res = await api<{ enabled: boolean; recoveryCodes: string[] }>(
                      '/v1/auth/mfa/enable',
                      { method: 'POST', json: { code } },
                    );
                    setSetup(null);
                    // Shown once: the API never returns these codes again.
                    setRecoveryCodes(res.recoveryCodes);
                  })
                }
              >
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        ) : null}
        {recoveryCodes ? (
          <>
            <p className="text-sm text-success">{t('passkeys.mfa.enabledWithCodes')}</p>
            <RecoveryCodesDisplay codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />
          </>
        ) : null}
        {enabled && !recoveryCodes ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isMfaCodeInput(code)) return;
              void run(() => api('/v1/auth/mfa/disable', { method: 'POST', json: { code } }));
            }}
          >
            <p className="text-xs text-muted-foreground">{t('passkeys.mfa.disableHint')}</p>
            <StepUpFields
              id="mfa-disable-code"
              code={code}
              onCodeChange={setCode}
              onPasskey={(passkeyAssertion) =>
                run(() => api('/v1/auth/mfa/disable', { method: 'POST', json: { passkeyAssertion } }))
              }
            />
            <Button type="submit" variant="destructive" loading={loading} disabled={!isMfaCodeInput(code)}>
              {t('settings.mfaDisable')}
            </Button>
          </form>
        ) : null}
        <FormMessage error={msg.error} success={msg.success} />
      </CardContent>
    </Card>
  );
}

export function SessionsCard({ sessions }: { sessions: any[] }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('settings.sessions')}</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            api('/v1/auth/sessions/revoke-others', { method: 'POST' }).then(() => router.refresh())
          }
        >
          {t('settings.revokeOthers')}
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <div className="min-w-0">
                <p className="truncate">{s.userAgent ?? '—'}</p>
                <p className="text-xs text-muted-foreground">
                  {s.ip ?? '—'} · {formatDate(s.lastSeenAt, locale, true)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
