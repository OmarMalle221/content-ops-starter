'use client';
import { XCircle } from 'lucide-react';
import { cancelTransactionAction } from '@/app/actions/transactions';
import { ConfirmAction } from '@/components/app/confirm-action';
import { useI18n } from '@/components/app/i18n-provider';
import { Field, Textarea } from '@/components/ui/form';

export function CancelTransaction({ transactionId }: { transactionId: string }) {
    const { t } = useI18n();
    return (
        <ConfirmAction
            action={cancelTransactionAction}
            hidden={{ transactionId }}
            trigger={
                <>
                    <XCircle aria-hidden /> {t('tx.cancelTx')}
                </>
            }
            triggerVariant="secondary"
            title={t('tx.cancelTx')}
            description={t('tx.cancelConfirm')}
            confirmLabel={t('tx.cancelTx')}
            variant="destructive"
        >
            <Field label={t('tx.cancelReason')} htmlFor="cancel-reason">
                <Textarea id="cancel-reason" name="reason" required maxLength={500} />
            </Field>
        </ConfirmAction>
    );
}
