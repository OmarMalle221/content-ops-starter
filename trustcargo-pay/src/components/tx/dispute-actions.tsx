'use client';
import { Gavel } from 'lucide-react';
import { disputeMessageAction, openDisputeAction, withdrawDisputeAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { ConfirmAction } from '@/components/app/confirm-action';
import { useI18n } from '@/components/app/i18n-provider';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { DISPUTE_REASONS } from '@/domain/model';

export function OpenDispute({ transactionId, milestones }: { transactionId: string; milestones: { id: string; title: string }[] }) {
    const { t } = useI18n();
    return (
        <ConfirmAction
            action={openDisputeAction}
            hidden={{ transactionId }}
            trigger={
                <>
                    <Gavel aria-hidden /> {t('dispute.open')}
                </>
            }
            triggerVariant="destructive"
            title={t('dispute.open')}
            description={t('dispute.openHelp')}
            confirmLabel={t('dispute.open')}
            variant="destructive"
        >
            <Field label={t('dispute.reason')} htmlFor="d-reason">
                <Select id="d-reason" name="reason" required>
                    {DISPUTE_REASONS.map((r) => (
                        <option key={r} value={r}>
                            {t(`disputeReason.${r}`)}
                        </option>
                    ))}
                </Select>
            </Field>
            {milestones.length > 0 && (
                <Field label={t('dispute.milestone')} htmlFor="d-milestone">
                    <Select id="d-milestone" name="milestoneId" defaultValue="">
                        <option value="">—</option>
                        {milestones.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.title}
                            </option>
                        ))}
                    </Select>
                </Field>
            )}
            <Field label={t('dispute.description')} htmlFor="d-desc" hint="20 – 5000">
                <Textarea id="d-desc" name="description" required minLength={20} maxLength={5000} rows={4} />
            </Field>
            <Field label={t('dispute.requestedOutcome')} htmlFor="d-outcome">
                <Input id="d-outcome" name="requestedOutcome" required maxLength={1000} />
            </Field>
        </ConfirmAction>
    );
}

export function DisputeReply({
    transactionId,
    disputeId,
    action
}: {
    transactionId: string;
    disputeId: string;
    action?: typeof disputeMessageAction;
}) {
    const { t } = useI18n();
    return (
        <ActionForm action={action ?? disputeMessageAction} resetOnSuccess className="space-y-2">
            <input type="hidden" name="transactionId" value={transactionId} />
            <input type="hidden" name="disputeId" value={disputeId} />
            <Field label={t('dispute.message')} htmlFor={`reply-${disputeId}`}>
                <Textarea id={`reply-${disputeId}`} name="body" required maxLength={5000} rows={3} />
            </Field>
            <SubmitButton size="sm">{t('dispute.send')}</SubmitButton>
        </ActionForm>
    );
}

export function WithdrawDispute({ transactionId, disputeId }: { transactionId: string; disputeId: string }) {
    const { t } = useI18n();
    return (
        <ConfirmAction
            action={withdrawDisputeAction}
            hidden={{ transactionId, disputeId }}
            trigger={t('dispute.withdraw')}
            triggerVariant="secondary"
            size="sm"
            title={t('dispute.withdraw')}
            confirmLabel={t('dispute.withdraw')}
        />
    );
}
