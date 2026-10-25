'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { COUNTRIES } from '@dfn/shared';
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
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { CopyButton } from '@/components/copy-button';

export function CreateOrganizationDialog() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', country: 'SN', legalName: '', registrationNumber: '' });
  return (
    <ActionDialog
      trigger={<Button>{t('business.create')}</Button>}
      title={t('business.create')}
      disabled={form.name.trim().length < 2}
      onConfirm={async () => {
        await api('/v1/organizations', {
          method: 'POST',
          json: {
            ...form,
            legalName: form.legalName || undefined,
            registrationNumber: form.registrationNumber || undefined,
          },
        });
        // memberships are part of the session: re-login to refresh
        await api('/v1/auth/logout', { method: 'POST' });
        router.push('/login?next=/business');
        router.refresh();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="org-name">{t('business.name')}</Label>
        <Input
          id="org-name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="org-country">{t('auth.country')}</Label>
        <Select
          id="org-country"
          value={form.country}
          onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
        >
          {Object.values(COUNTRIES).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name[locale]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="org-legal">{t('business.legalName')}</Label>
        <Input
          id="org-legal"
          value={form.legalName}
          onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="org-reg">{t('business.registrationNumber')}</Label>
        <Input
          id="org-reg"
          value={form.registrationNumber}
          onChange={(e) => setForm((f) => ({ ...f, registrationNumber: e.target.value }))}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('business.reloginHint')}</p>
    </ActionDialog>
  );
}

export function InviteMemberCard({ organizationId }: { organizationId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('business.invite')}</CardTitle>
        <CardDescription>{t('tx.invitationHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            setError(null);
            try {
              const r = await api(`/v1/organizations/${organizationId}/members/invite`, {
                method: 'POST',
                json: { email, role },
              });
              // Support invitations never return the link: only the invitee receives it.
              setLink(r.acceptUrl ? `${window.location.origin}${new URL(r.acceptUrl).pathname}` : null);
              setEmail('');
              router.refresh();
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setLoading(false);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="inv-email">{t('auth.email')}</Label>
            <Input
              id="inv-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-64"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv-role">{t('common.role')}</Label>
            <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)} className="w-40">
              <option value="ADMIN">ADMIN</option>
              <option value="MEMBER">MEMBER</option>
              <option value="VIEWER">VIEWER</option>
            </Select>
          </div>
          <Button type="submit" loading={loading}>
            {t('common.send')}
          </Button>
        </form>
        {link ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('business.inviteLink')}:</span>
            <code className="truncate rounded-md border bg-muted px-2 py-1">{link}</code>
            <CopyButton value={link} />
          </div>
        ) : null}
        <FormMessage error={error} />
      </CardContent>
    </Card>
  );
}

export function BusinessVerificationCard({ org }: { org: any }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({
    legalName: org.legalName ?? '',
    registrationNumber: org.registrationNumber ?? '',
    registrationCountry: org.country,
    businessType: 'COMPANY',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('business.verification')}</CardTitle>
        <CardDescription>{t(`status.${org.verificationStatus}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        {org.verificationStatus === 'SIMULATED_PASS' ? (
          <p className="text-sm text-success">{t('status.SIMULATED_PASS')}</p>
        ) : (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              setError(null);
              try {
                await api(`/v1/organizations/${org.id}/verification`, { method: 'POST', json: form });
                router.refresh();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setLoading(false);
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="kyb-legal">{t('business.legalName')}</Label>
              <Input
                id="kyb-legal"
                required
                minLength={2}
                value={form.legalName}
                onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kyb-reg">{t('business.registrationNumber')}</Label>
              <Input
                id="kyb-reg"
                required
                minLength={2}
                value={form.registrationNumber}
                onChange={(e) => setForm((f) => ({ ...f, registrationNumber: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kyb-country">{t('auth.country')}</Label>
              <Select
                id="kyb-country"
                value={form.registrationCountry}
                onChange={(e) => setForm((f) => ({ ...f, registrationCountry: e.target.value }))}
              >
                {Object.values(COUNTRIES).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name[locale]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="kyb-type">{t('business.businessType')}</Label>
              <Select
                id="kyb-type"
                value={form.businessType}
                onChange={(e) => setForm((f) => ({ ...f, businessType: e.target.value }))}
              >
                {['SOLE_PROPRIETOR', 'COMPANY', 'COOPERATIVE', 'NGO', 'OTHER'].map((x) => (
                  <option key={x} value={x}>
                    {t(`business.types.${x}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2">
              <FormMessage error={error} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" loading={loading}>
                {t('business.submitVerification')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
