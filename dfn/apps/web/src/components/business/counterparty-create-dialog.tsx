'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { COUNTRIES } from '@dfn/shared';
import { Button, Input, Label, Select, Textarea } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

/**
 * Creates a client record (counterparty). With an e-mail, the API sends a link request to the
 * matching DFN account, if any — the answer never says whether one matched (consent workflow).
 */
export function CounterpartyCreateDialog({ organizationId }: { organizationId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', phone: '', country: '', notes: '' });
  return (
    <ActionDialog
      trigger={
        <Button>
          <UserPlus /> {t('clientsX.new')}
        </Button>
      }
      title={t('clientsX.new')}
      description={`${t('clientsX.linkedHint')} ${t('counterpartyLinks.consentHint')}`}
      disabled={form.name.trim().length === 0}
      onConfirm={async () => {
        await api(`/v1/organizations/${organizationId}/counterparties`, {
          method: 'POST',
          json: {
            name: form.name.trim(),
            email: form.email.trim() || undefined,
            phone: form.phone.trim() || undefined,
            country: form.country || undefined,
            notes: form.notes.trim() || undefined,
          },
        });
        setForm({ name: '', email: '', phone: '', country: '', notes: '' });
        router.refresh();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="cp-name">{t('clientsX.name')}</Label>
        <Input
          id="cp-name"
          required
          maxLength={120}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="cp-email">{t('clientsX.email')}</Label>
          <Input
            id="cp-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cp-phone">{t('clientsX.phone')}</Label>
          <Input
            id="cp-phone"
            maxLength={30}
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="cp-country">{t('clientsX.country')}</Label>
        <Select
          id="cp-country"
          value={form.country}
          onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
        >
          <option value="">—</option>
          {Object.values(COUNTRIES).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name[locale]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="cp-notes">{t('clientsX.notes')}</Label>
        <Textarea
          id="cp-notes"
          maxLength={1000}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>
    </ActionDialog>
  );
}
