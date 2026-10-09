'use client';
import { Ban, CheckCircle2, Landmark, PlugZap, TriangleAlert } from 'lucide-react';
import { requestFundingAction, simulateFundingAction, simulateOutageAction, simulateTransferAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { useI18n } from '@/components/app/i18n-provider';

export function RequestFunding({ transactionId }: { transactionId: string }) {
    const { t } = useI18n();
    return (
        <ActionForm action={requestFundingAction}>
            <input type="hidden" name="transactionId" value={transactionId} />
            <SubmitButton>
                <Landmark aria-hidden /> {t('payment.request')}
            </SubmitButton>
        </ActionForm>
    );
}

export function PartnerSimulator({
    transactionId,
    instructionReference,
    transfers
}: {
    transactionId: string;
    instructionReference?: string;
    transfers: { reference: string; kind: 'PAYOUT' | 'REFUND'; status: string }[];
}) {
    const { t } = useI18n();
    return (
        <div className="space-y-3">
            {instructionReference && (
                <div className="flex flex-wrap gap-2">
                    {(
                        [
                            ['ok', t('payment.simFund'), CheckCircle2, 'success'],
                            ['wrong', t('payment.simFundWrong'), TriangleAlert, 'secondary'],
                            ['fail', t('payment.simFail'), Ban, 'secondary']
                        ] as const
                    ).map(([mode, label, Icon, variant]) => (
                        <ActionForm key={mode} action={simulateFundingAction}>
                            <input type="hidden" name="transactionId" value={transactionId} />
                            <input type="hidden" name="mode" value={mode} />
                            <SubmitButton variant={variant} size="sm" data-testid={`sim-fund-${mode}`}>
                                <Icon aria-hidden /> {label}
                            </SubmitButton>
                        </ActionForm>
                    ))}
                </div>
            )}
            {transfers.map((tr) => (
                <div key={tr.reference} className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2">
                    <span className="flex-1 text-sm">
                        {tr.kind === 'PAYOUT' ? t('payment.payouts') : t('payment.refunds')} ·{' '}
                        <span className="font-mono text-xs">{tr.reference}</span>
                    </span>
                    {(['PAID', 'FAILED'] as const).map((outcome) => (
                        <ActionForm key={outcome} action={simulateTransferAction}>
                            <input type="hidden" name="transactionId" value={transactionId} />
                            <input type="hidden" name="reference" value={tr.reference} />
                            <input type="hidden" name="outcome" value={outcome} />
                            <SubmitButton
                                size="sm"
                                variant={outcome === 'PAID' ? 'success' : 'secondary'}
                                data-testid={`sim-transfer-${outcome.toLowerCase()}`}
                            >
                                {outcome === 'PAID' ? t('payment.simPay') : t('payment.simPayFail')}
                            </SubmitButton>
                        </ActionForm>
                    ))}
                </div>
            ))}
            {!instructionReference && transfers.length === 0 && <p className="text-sm text-muted-foreground">{t('payment.noSimAction')}</p>}
            <ActionForm action={simulateOutageAction} successMessage={t('common.success')}>
                <input type="hidden" name="transactionId" value={transactionId} />
                <SubmitButton size="sm" variant="ghost">
                    <PlugZap aria-hidden /> {t('payment.simOutage')}
                </SubmitButton>
            </ActionForm>
        </div>
    );
}
