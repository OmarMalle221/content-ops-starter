'use client';
import { ShieldCheck } from 'lucide-react';
import { completeKycAction, startKycAction } from '@/app/actions/account';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';

export function StartKyc() {
    const { t } = useI18n();
    return (
        <ActionForm action={startKycAction}>
            <SubmitButton data-testid="kyc-start">
                <ShieldCheck aria-hidden /> {t('verification.start')}
            </SubmitButton>
        </ActionForm>
    );
}

export function SimulateKyc({ verificationId }: { verificationId: string }) {
    const { t } = useI18n();
    return (
        <div className="flex flex-wrap gap-2">
            {(
                [
                    ['APPROVE', t('verification.approve'), 'success'],
                    ['REVIEW', t('verification.review'), 'secondary'],
                    ['REJECT', t('verification.reject'), 'secondary']
                ] as const
            ).map(([outcome, label, variant]) => (
                <ActionForm key={outcome} action={completeKycAction}>
                    <input type="hidden" name="verificationId" value={verificationId} />
                    <input type="hidden" name="outcome" value={outcome} />
                    <SubmitButton variant={variant} size="sm" data-testid={`kyc-${outcome.toLowerCase()}`}>
                        {label}
                    </SubmitButton>
                </ActionForm>
            ))}
        </div>
    );
}
