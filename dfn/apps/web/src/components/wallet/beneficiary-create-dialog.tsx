'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { BeneficiaryMethod, COUNTRIES, SUPPORTED_CURRENCY_CODES } from '@dfn/shared';
import { Button, Input, Label, Select } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

/** Same masking rule as the API: whitespace stripped, last 4 characters kept. */
export function maskPreview(identifier: string): string {
  const compact = identifier.replace(/\s+/g, '');
  if (compact.length < 4) return compact.length ? '••••' : '';
  return `••••${compact.slice(-4)}`;
}

const INITIAL = {
  name: '',
  country: 'SN',
  currencyCode: 'XOF',
  method: BeneficiaryMethod.BANK_ACCOUNT as string,
  accountIdentifier: '',
  institutionName: '',
  phone: '',
  email: '',
};

export function BeneficiaryCreateDialog({ organizationId }: { organizationId: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState(INITIAL);
  const isMobile = form.method === BeneficiaryMethod.MOBILE_MONEY;
  const identifierOk = isMobile
    ? /^\+?\d{8,15}$/.test(form.accountIdentifier.replace(/\s/g, ''))
    : form.accountIdentifier.trim().length >= 6;
  const valid = form.name.trim().length >= 2 && identifierOk;
  const set = (patch: Partial<typeof INITIAL>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <ActionDialog
      trigger={
        <Button>
          <UserPlus /> {t('beneficiary.add')}
        </Button>
      }
      title={t('beneficiary.add')}
      description={t('beneficiary.encryptedHint')}
      confirmLabel={t('common.save')}
      disabled={!valid}
      onConfirm={async () => {
        try {
          await api('/v1/beneficiaries', {
            method: 'POST',
            json: {
              organizationId,
              name: form.name.trim(),
              country: form.country,
              currencyCode: form.currencyCode,
              method: form.method,
              accountIdentifier: form.accountIdentifier.trim(),
              institutionName: form.institutionName.trim() || undefined,
              // Only a phone the user actually typed: the account identifier (even a mobile-money
              // number) is stored encrypted and must never be copied into a clear-text field.
              phone: form.phone.trim() || undefined,
              email: form.email.trim() || undefined,
            },
          });
        } catch (e) {
          throw new Error(errorMessage(e));
        }
        setForm(INITIAL);
        router.refresh();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="b-name">{t('beneficiary.name')}</Label>
          <Input id="b-name" value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="b-country">{t('beneficiary.country')}</Label>
          <Select
            id="b-country"
            value={form.country}
            onChange={(e) => {
              const country = e.target.value;
              set({ country, currencyCode: COUNTRIES[country]?.defaultCurrency ?? form.currencyCode });
            }}
          >
            {Object.values(COUNTRIES).map((c) => (
              <option key={c.code} value={c.code}>
                {c.name[locale]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="b-currency">{t('beneficiary.currency')}</Label>
          <Select
            id="b-currency"
            value={form.currencyCode}
            onChange={(e) => set({ currencyCode: e.target.value })}
          >
            {SUPPORTED_CURRENCY_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="b-method">{t('beneficiary.method')}</Label>
          <Select
            id="b-method"
            value={form.method}
            onChange={(e) => set({ method: e.target.value, accountIdentifier: '' })}
          >
            {Object.values(BeneficiaryMethod).map((m) => (
              <option key={m} value={m}>
                {t(`beneficiary.methods.${m}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="b-institution">{t('beneficiary.institution')}</Label>
          <Input
            id="b-institution"
            value={form.institutionName}
            placeholder={isMobile ? 'Wave, Orange Money…' : 'CBAO, Ecobank…'}
            onChange={(e) => set({ institutionName: e.target.value })}
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="b-identifier">
            {isMobile ? t('beneficiary.mobileIdentifier') : t('beneficiary.bankIdentifier')}
          </Label>
          <Input
            id="b-identifier"
            value={form.accountIdentifier}
            inputMode={isMobile ? 'tel' : 'text'}
            placeholder={isMobile ? '+221771234567' : 'SN08 SN01 0152 0000 0012 3456 7890'}
            autoComplete="off"
            onChange={(e) => set({ accountIdentifier: e.target.value })}
            aria-invalid={form.accountIdentifier.length > 0 && !identifierOk}
            required
          />
          <p className="text-xs text-muted-foreground">
            {isMobile ? t('beneficiary.mobileHint') : t('beneficiary.encryptedHint')}
          </p>
          {form.accountIdentifier ? (
            <p className="text-xs">
              <span className="text-muted-foreground">{t('beneficiary.preview')} </span>
              <span className="font-mono">{maskPreview(form.accountIdentifier)}</span>
              <span className="text-muted-foreground"> — {t('beneficiary.previewHint')}</span>
            </p>
          ) : null}
        </div>
        {!isMobile ? (
          <div className="space-y-2">
            <Label htmlFor="b-phone">{t('beneficiary.phone')}</Label>
            <Input
              id="b-phone"
              value={form.phone}
              inputMode="tel"
              onChange={(e) => set({ phone: e.target.value })}
            />
          </div>
        ) : null}
        <div className={`space-y-2 ${isMobile ? 'sm:col-span-2' : ''}`}>
          <Label htmlFor="b-email">{t('beneficiary.email')}</Label>
          <Input
            id="b-email"
            type="email"
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>
      </div>
    </ActionDialog>
  );
}
