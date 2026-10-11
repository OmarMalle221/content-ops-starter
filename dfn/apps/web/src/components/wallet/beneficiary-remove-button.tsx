'use client';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { Button } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';

export function BeneficiaryRemoveButton({
  beneficiary,
}: {
  beneficiary: { id: string; name: string; accountIdentifierMasked: string };
}) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <ActionDialog
      trigger={
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
          <Trash2 /> {t('beneficiary.remove')}
        </Button>
      }
      title={t('beneficiary.removeTitle')}
      description={t('beneficiary.removeDescription')}
      confirmLabel={t('beneficiary.remove')}
      variant="destructive"
      onConfirm={async () => {
        try {
          await api(`/v1/beneficiaries/${beneficiary.id}`, { method: 'DELETE' });
        } catch (e) {
          throw new Error(errorMessage(e));
        }
        router.refresh();
      }}
    >
      <p className="text-sm">
        <span className="font-medium">{beneficiary.name}</span>{' '}
        <span className="font-mono text-muted-foreground">{beneficiary.accountIdentifierMasked}</span>
      </p>
    </ActionDialog>
  );
}
