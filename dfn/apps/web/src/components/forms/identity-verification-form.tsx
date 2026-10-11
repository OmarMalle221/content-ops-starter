'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { COUNTRIES } from '@dfn/shared';
import { Button, Label, Select } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';

const DOCUMENT_TYPES = ['PASSPORT', 'NATIONAL_ID', 'DRIVER_LICENSE', 'RESIDENCE_PERMIT'] as const;

export function IdentityVerificationForm({ compact = false }: { compact?: boolean }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [documentType, setDocumentType] = useState('PASSPORT');
  const [issuingCountry, setIssuingCountry] = useState('CA');
  const [fail, setFail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/v1/verifications/identity', {
        method: 'POST',
        json: { documentType, issuingCountry, ...(fail ? { sandboxOutcome: 'FAIL' } : {}) },
      });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }
  return (
    <form onSubmit={submit} className={compact ? 'flex flex-wrap items-end gap-3' : 'space-y-4'}>
      <div className="space-y-2">
        <Label htmlFor="documentType">{t('settings.documentType')}</Label>
        <Select id="documentType" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
          {DOCUMENT_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`settings.documentTypes.${x}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="issuingCountry">{t('settings.issuingCountry')}</Label>
        <Select
          id="issuingCountry"
          value={issuingCountry}
          onChange={(e) => setIssuingCountry(e.target.value)}
        >
          {Object.values(COUNTRIES).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name[locale]}
            </option>
          ))}
        </Select>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />{' '}
        {t('settings.simulateFail')}
      </label>
      <Button type="submit" loading={loading}>
        {t('dashboard.verifyNow')}
      </Button>
      <FormMessage error={error} />
    </form>
  );
}
