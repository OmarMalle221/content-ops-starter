'use client';
import { CheckCheck, RotateCcw, Send } from 'lucide-react';
import { attachEvidenceAction, reviewMilestoneAction, submitMilestoneAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { ConfirmAction } from '@/components/app/confirm-action';
import { useI18n } from '@/components/app/i18n-provider';
import { Field, Select, Textarea } from '@/components/ui/form';

export function SubmitMilestone({
    transactionId,
    milestoneId,
    disabled
}: {
    transactionId: string;
    milestoneId: string;
    disabled: boolean;
}) {
    const { t } = useI18n();
    return (
        <ActionForm action={submitMilestoneAction} className="space-y-3">
            <input type="hidden" name="transactionId" value={transactionId} />
            <input type="hidden" name="milestoneId" value={milestoneId} />
            <Field label={t('milestone.submitNote')} htmlFor={`note-${milestoneId}`}>
                <Textarea id={`note-${milestoneId}`} name="note" rows={2} maxLength={2000} />
            </Field>
            <SubmitButton disabled={disabled}>
                <Send aria-hidden /> {t('milestone.submit')}
            </SubmitButton>
        </ActionForm>
    );
}

export function ReviewMilestone({
    transactionId,
    milestoneId,
    amountLabel
}: {
    transactionId: string;
    milestoneId: string;
    amountLabel: string;
}) {
    const { t } = useI18n();
    const hidden = { transactionId, milestoneId };
    return (
        <div className="flex flex-wrap gap-2">
            <ConfirmAction
                action={reviewMilestoneAction}
                hidden={{ ...hidden, decision: 'APPROVE' }}
                trigger={
                    <>
                        <CheckCheck aria-hidden /> {t('milestone.approve')}
                    </>
                }
                title={t('milestone.approve')}
                description={t('milestone.approveConfirm', { amount: amountLabel })}
                confirmLabel={t('milestone.approve')}
                variant="success"
            />
            <ConfirmAction
                action={reviewMilestoneAction}
                hidden={{ ...hidden, decision: 'REQUEST_CHANGES' }}
                trigger={
                    <>
                        <RotateCcw aria-hidden /> {t('milestone.requestChanges')}
                    </>
                }
                triggerVariant="secondary"
                title={t('milestone.requestChanges')}
                confirmLabel={t('milestone.requestChanges')}
            >
                <Field label={t('milestone.changesReason')} htmlFor={`reason-${milestoneId}`}>
                    <Textarea id={`reason-${milestoneId}`} name="reason" required minLength={3} maxLength={2000} />
                </Field>
            </ConfirmAction>
        </div>
    );
}

export function AttachEvidence({
    transactionId,
    milestoneId,
    documents
}: {
    transactionId: string;
    milestoneId: string;
    documents: { id: string; label: string }[];
}) {
    const { t } = useI18n();
    if (!documents.length) return null;
    return (
        <ActionForm action={attachEvidenceAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="transactionId" value={transactionId} />
            <input type="hidden" name="milestoneId" value={milestoneId} />
            <Field label={t('documents.attachExisting')} htmlFor={`attach-${milestoneId}`} className="flex-1">
                <Select id={`attach-${milestoneId}`} name="documentId">
                    {documents.map((d) => (
                        <option key={d.id} value={d.id}>
                            {d.label}
                        </option>
                    ))}
                </Select>
            </Field>
            <SubmitButton variant="secondary">{t('documents.attach')}</SubmitButton>
        </ActionForm>
    );
}
