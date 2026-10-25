'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
import { startRegistration, type AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { StepUpOperation } from '@dfn/shared';
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
import { api, errorMessage, localizedApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { StepUpFields } from './step-up-fields';
import {
  isMfaCodeInput,
  useWebAuthnSupport,
  webAuthnErrorMessage,
  type StepUpProof,
} from './webauthn-client';

export interface PasskeyItem {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
  transports: string[];
  status: 'ACTIVE' | 'REVOKED';
  nextActions: string[];
}

/** Settings card: the account's passkeys — add (WebAuthn registration), rename, revoke (step-up). */
export function PasskeysCard({ passkeys, mfaEnabled }: { passkeys: PasskeyItem[]; mfaEnabled: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const supported = useWebAuthnSupport();
  const [name, setName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ error?: string; success?: string }>({});
  // Adding a durable credential needs a fresh proof: a second factor with MFA, else the password.
  const proofReady = mfaEnabled ? isMfaCodeInput(code) : currentPassword.length > 0;

  async function add(proof: StepUpProof | { currentPassword: string }) {
    setLoading(true);
    setMsg({});
    try {
      const optionsJSON = await api('/v1/auth/passkeys/registration/options', {
        method: 'POST',
        json: proof,
      });
      const response = await startRegistration({ optionsJSON });
      await api('/v1/auth/passkeys/registration/verify', {
        method: 'POST',
        json: { name: name.trim(), response },
      });
      setName('');
      setCurrentPassword('');
      setCode('');
      setMsg({ success: t('passkeys.added') });
      router.refresh();
    } catch (err) {
      setMsg({ error: webAuthnErrorMessage(err, t) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> {t('passkeys.title')}
        </CardTitle>
        <CardDescription>{t('passkeys.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('passkeys.empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {passkeys.map((p) => (
              <PasskeyRow key={p.id} passkey={p} mfaEnabled={mfaEnabled} />
            ))}
          </ul>
        )}
        {supported === null ? (
          <p className="text-xs text-muted-foreground">{t('passkeys.checking')}</p>
        ) : supported ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !proofReady) return;
              void add(mfaEnabled ? { mfaCode: code } : { currentPassword });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="passkey-name">{t('passkeys.nameLabel')}</Label>
              <Input
                id="passkey-name"
                maxLength={60}
                placeholder={t('passkeys.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {mfaEnabled ? (
              <StepUpFields
                id="passkey-add-code"
                operation={StepUpOperation.PASSKEY_REGISTER}
                code={code}
                onCodeChange={setCode}
                passkeyDisabled={!name.trim()}
                onPasskey={(passkeyAssertion) => add({ passkeyAssertion })}
              />
            ) : (
              <div className="space-y-2">
                <Label htmlFor="passkey-add-password">{t('settings.currentPassword')}</Label>
                <Input
                  id="passkey-add-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t('passkeys.addProofHint')}</p>
              </div>
            )}
            <Button type="submit" loading={loading} disabled={!name.trim() || !proofReady}>
              <KeyRound /> {t('passkeys.add')}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">{t('passkeys.unsupported')}</p>
        )}
        <FormMessage error={msg.error} success={msg.success} />
        <p className="text-xs text-muted-foreground">{t('passkeys.sandboxNote')}</p>
      </CardContent>
    </Card>
  );
}

function PasskeyRow({ passkey, mfaEnabled }: { passkey: PasskeyItem; mfaEnabled: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(passkey.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const assertion = useRef<AuthenticationResponseJSON | null>(null);
  const synced = passkey.backedUp || passkey.deviceType === 'multiDevice';

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setSaving(true);
                setError(null);
                try {
                  await api(`/v1/auth/passkeys/${passkey.id}`, {
                    method: 'PATCH',
                    json: { name: name.trim() },
                  });
                  setEditing(false);
                  router.refresh();
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setSaving(false);
                }
              }}
            >
              <Input
                aria-label={t('passkeys.nameLabel')}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8"
              />
              <Button type="submit" size="sm" loading={saving} disabled={!name.trim()}>
                {t('common.save')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setName(passkey.name);
                }}
              >
                {t('common.cancel')}
              </Button>
            </form>
          ) : (
            <p className="truncate font-medium">{passkey.name}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {t('passkeys.createdAt')} {formatDate(passkey.createdAt, locale)} · {t('passkeys.lastUsed')}{' '}
            {passkey.lastUsedAt ? formatDate(passkey.lastUsedAt, locale, true) : t('passkeys.never')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{synced ? t('passkeys.synced') : t('passkeys.deviceBound')}</Badge>
          {!editing && passkey.nextActions.includes('RENAME') ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil /> {t('passkeys.rename')}
            </Button>
          ) : null}
          {passkey.nextActions.includes('REVOKE') ? (
            <ActionDialog
              trigger={
                <Button type="button" size="sm" variant="ghost">
                  <Trash2 /> {t('passkeys.revoke')}
                </Button>
              }
              title={t('passkeys.revokeTitle')}
              description={t('passkeys.revokeDescription')}
              confirmLabel={t('passkeys.revoke')}
              variant="destructive"
              disabled={mfaEnabled && !isMfaCodeInput(code)}
              onConfirm={async () => {
                const proof: StepUpProof = assertion.current
                  ? { passkeyAssertion: assertion.current }
                  : mfaEnabled
                    ? { mfaCode: code }
                    : {};
                assertion.current = null;
                try {
                  await api(`/v1/auth/passkeys/${passkey.id}`, { method: 'DELETE', json: proof });
                } catch (e) {
                  throw new Error(localizedApiError(e, t));
                }
                setCode('');
                router.refresh();
              }}
            >
              <p className="text-sm font-medium">{passkey.name}</p>
              {mfaEnabled ? (
                <StepUpFields
                  id={`revoke-${passkey.id}`}
                  operation={StepUpOperation.PASSKEY_REVOKE}
                  resourceId={passkey.id}
                  code={code}
                  onCodeChange={setCode}
                  onPasskey={(a, form) => {
                    assertion.current = a;
                    form?.requestSubmit();
                  }}
                />
              ) : null}
            </ActionDialog>
          ) : null}
        </div>
      </div>
      <FormMessage error={error} />
    </li>
  );
}
