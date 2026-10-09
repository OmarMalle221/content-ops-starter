'use client';
import * as React from 'react';
import { Gavel, Lock, LockOpen, RefreshCcw, RotateCcw, Scale } from 'lucide-react';
import {
    adminDisputeMessageAction,
    archiveDisputeAction,
    assignDisputeAction,
    decideDisputeAction,
    injectDiscrepancyAction,
    liftHoldAction,
    placeHoldAction,
    reprocessEventAction,
    retryReleasesAction,
    reverseJournalAction,
    reviewDocumentAction,
    reviewKycAction,
    reviewRiskAction,
    runReconciliationAction,
    updateCorridorAction,
    updateSecurityAction
} from '@/app/actions/admin';
import { resetDemoAction } from '@/app/actions/auth';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { ConfirmAction } from '@/components/app/confirm-action';
import { useI18n } from '@/components/app/i18n-provider';
import { DisputeReply } from '@/components/tx/dispute-actions';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';

export function RiskReviewForm({ alertId, transactionId }: { alertId: string; transactionId?: string }) {
    const { t, dict } = useI18n();
    return (
        <details className="rounded-md border bg-muted/30">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-primary">{t('risk.review')}</summary>
            <ActionForm action={reviewRiskAction} className="space-y-3 border-t p-3" resetOnSuccess>
                <input type="hidden" name="alertId" value={alertId} />
                <input type="hidden" name="transactionId" value={transactionId ?? ''} />
                <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
                    <Field label={t('common.status')} htmlFor={`rd-${alertId}`}>
                        <Select id={`rd-${alertId}`} name="decision">
                            {Object.entries(dict.risk.decision).map(([k, v]) => (
                                <option key={k} value={k}>
                                    {v}
                                </option>
                            ))}
                        </Select>
                    </Field>
                    <Field label={t('common.notes')} htmlFor={`rn-${alertId}`}>
                        <Textarea id={`rn-${alertId}`} name="notes" required minLength={5} rows={2} />
                    </Field>
                </div>
                <SubmitButton size="sm">{t('common.save')}</SubmitButton>
            </ActionForm>
        </details>
    );
}

export function PlaceHold({ transactionId }: { transactionId: string }) {
    const { t, dict } = useI18n();
    return (
        <ConfirmAction
            action={placeHoldAction}
            hidden={{ transactionId }}
            trigger={
                <>
                    <Lock aria-hidden /> {t('risk.hold')}
                </>
            }
            triggerVariant="destructive"
            title={t('risk.hold')}
            description={t('dispute.legalNote')}
            confirmLabel={t('risk.hold')}
            variant="destructive"
        >
            <Field label="Type" htmlFor="hold-type">
                <Select id="hold-type" name="type">
                    {Object.entries(dict.risk.holdType).map(([k, v]) => (
                        <option key={k} value={k}>
                            {v}
                        </option>
                    ))}
                </Select>
            </Field>
            <Field label={t('common.reference')} htmlFor="hold-ref">
                <Input id="hold-ref" name="reference" required maxLength={120} />
            </Field>
            <Field label={t('common.notes')} htmlFor="hold-notes">
                <Textarea id="hold-notes" name="notes" required minLength={5} />
            </Field>
        </ConfirmAction>
    );
}

export function LiftHold({ holdId, transactionId }: { holdId: string; transactionId: string }) {
    const { t } = useI18n();
    return (
        <ConfirmAction
            action={liftHoldAction}
            hidden={{ holdId, transactionId }}
            trigger={
                <>
                    <LockOpen aria-hidden /> {t('risk.liftHold')}
                </>
            }
            triggerVariant="secondary"
            size="sm"
            title={t('risk.liftHold')}
            confirmLabel={t('risk.liftHold')}
        >
            <Field label={t('admin.justification')} htmlFor={`lift-${holdId}`}>
                <Textarea id={`lift-${holdId}`} name="notes" required minLength={5} />
            </Field>
        </ConfirmAction>
    );
}

export function RetryReleases({ transactionId }: { transactionId: string }) {
    const { t } = useI18n();
    return (
        <ActionForm action={retryReleasesAction} successMessage={t('common.success')}>
            <input type="hidden" name="transactionId" value={transactionId} />
            <SubmitButton variant="secondary">
                <RefreshCcw aria-hidden /> {t('admin.retryReleases')}
            </SubmitButton>
        </ActionForm>
    );
}

export function DisputeStaffPanel({
    disputeId,
    transactionId,
    status,
    heldLabel
}: {
    disputeId: string;
    transactionId: string;
    status: string;
    heldLabel: string;
}) {
    const { t, dict } = useI18n();
    const [outcome, setOutcome] = React.useState('RESUME');
    const open = status === 'AWAITING_RESPONSE' || status === 'UNDER_REVIEW';
    return (
        <div className="space-y-4 rounded-lg border border-primary/30 bg-primary-soft/30 p-4">
            <div className="flex flex-wrap gap-2">
                {open && (
                    <ActionForm action={assignDisputeAction}>
                        <input type="hidden" name="disputeId" value={disputeId} />
                        <SubmitButton size="sm" variant="secondary">
                            {t('dispute.assign')}
                        </SubmitButton>
                    </ActionForm>
                )}
                {(status === 'RESOLVED' || status === 'WITHDRAWN') && (
                    <ActionForm action={archiveDisputeAction}>
                        <input type="hidden" name="disputeId" value={disputeId} />
                        <SubmitButton size="sm" variant="secondary">
                            {t('dispute.archive')}
                        </SubmitButton>
                    </ActionForm>
                )}
            </div>
            {open && <DisputeReply transactionId={transactionId} disputeId={disputeId} action={adminDisputeMessageAction} />}
            {open && (
                <ConfirmAction
                    action={decideDisputeAction}
                    hidden={{ disputeId, transactionId }}
                    trigger={
                        <>
                            <Gavel aria-hidden /> {t('dispute.decide')}
                        </>
                    }
                    title={t('dispute.decide')}
                    description={`${t('dispute.decideHelp')} (${t('tx.fundsHeld')} : ${heldLabel})`}
                    confirmLabel={t('dispute.decide')}
                >
                    <Field label={t('dispute.outcome')} htmlFor={`o-${disputeId}`}>
                        <Select id={`o-${disputeId}`} name="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                            {Object.entries(dict.disputeOutcome).map(([k, v]) => (
                                <option key={k} value={k}>
                                    {v}
                                </option>
                            ))}
                        </Select>
                    </Field>
                    {outcome === 'SPLIT' && (
                        <Field label={t('dispute.sellerAmount')} htmlFor={`sa-${disputeId}`}>
                            <Input id={`sa-${disputeId}`} name="sellerAmount" inputMode="decimal" required />
                        </Field>
                    )}
                    <Field label={t('dispute.rationale')} htmlFor={`ra-${disputeId}`}>
                        <Textarea id={`ra-${disputeId}`} name="rationale" required minLength={20} rows={4} />
                    </Field>
                    <Field label={t('dispute.clause')} htmlFor={`cl-${disputeId}`}>
                        <Input id={`cl-${disputeId}`} name="contractClause" required maxLength={200} />
                    </Field>
                </ConfirmAction>
            )}
        </div>
    );
}

export function KycReviewForm({ verificationId }: { verificationId: string }) {
    const { t } = useI18n();
    return (
        <ActionForm action={reviewKycAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="verificationId" value={verificationId} />
            <Field label={t('admin.justification')} htmlFor={`kn-${verificationId}`} className="flex-1">
                <Input id={`kn-${verificationId}`} name="note" required minLength={5} />
            </Field>
            <div className="flex gap-2">
                <SubmitButton size="sm" variant="success" name="decision" value="VERIFIED">
                    {t('admin.approve')}
                </SubmitButton>
                <SubmitButton size="sm" variant="destructive" name="decision" value="REJECTED">
                    {t('admin.reject')}
                </SubmitButton>
            </div>
        </ActionForm>
    );
}

export function DocumentReviewForm({ documentId }: { documentId: string }) {
    const { t } = useI18n();
    return (
        <ActionForm action={reviewDocumentAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="documentId" value={documentId} />
            <Field label={t('common.notes')} htmlFor={`dn-${documentId}`} className="flex-1">
                <Input id={`dn-${documentId}`} name="notes" required minLength={3} />
            </Field>
            <div className="flex gap-2">
                <SubmitButton size="sm" variant="success" name="decision" value="VERIFIED">
                    {t('admin.approve')}
                </SubmitButton>
                <SubmitButton size="sm" variant="secondary" name="decision" value="NEEDS_INFO">
                    ?
                </SubmitButton>
                <SubmitButton size="sm" variant="destructive" name="decision" value="REJECTED">
                    {t('admin.reject')}
                </SubmitButton>
            </div>
        </ActionForm>
    );
}

export function RunReconciliation({ demo }: { demo: boolean }) {
    const { t } = useI18n();
    return (
        <div className="flex flex-wrap gap-2">
            <ActionForm action={runReconciliationAction}>
                <SubmitButton>
                    <Scale aria-hidden /> {t('admin.runReconciliation')}
                </SubmitButton>
            </ActionForm>
            {demo && (
                <ActionForm action={injectDiscrepancyAction} successMessage={t('common.success')}>
                    <SubmitButton variant="secondary">{t('admin.injectDiscrepancy')}</SubmitButton>
                </ActionForm>
            )}
        </div>
    );
}

export function ReverseJournal({ journalId }: { journalId: string }) {
    const { t } = useI18n();
    return (
        <ConfirmAction
            action={reverseJournalAction}
            hidden={{ journalId }}
            trigger={
                <>
                    <RotateCcw aria-hidden /> {t('admin.reverse')}
                </>
            }
            triggerVariant="ghost"
            size="sm"
            title={t('admin.reverse')}
            confirmLabel={t('admin.reverse')}
            variant="destructive"
        >
            <Field label={t('common.reason')} htmlFor={`rev-${journalId}`}>
                <Textarea id={`rev-${journalId}`} name="reason" required minLength={5} />
            </Field>
        </ConfirmAction>
    );
}

export function ReprocessEvent({ eventId }: { eventId: string }) {
    const { t } = useI18n();
    return (
        <ActionForm action={reprocessEventAction}>
            <input type="hidden" name="eventId" value={eventId} />
            <SubmitButton size="sm" variant="secondary">
                {t('admin.reprocess')}
            </SubmitButton>
        </ActionForm>
    );
}

export function CorridorForm({
    corridorId,
    enabled,
    threshold,
    currency
}: {
    corridorId: string;
    enabled: boolean;
    threshold: string;
    currency: string;
}) {
    const { t } = useI18n();
    return (
        <ActionForm
            action={updateCorridorAction}
            successMessage={t('common.success')}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
        >
            <input type="hidden" name="corridorId" value={corridorId} />
            <input type="hidden" name="reviewThresholdCurrency" value={currency} />
            <label className="flex items-center gap-2 text-sm font-medium sm:pb-2">
                <Checkbox name="enabled" defaultChecked={enabled} /> {t('admin.corridorEnabled')}
            </label>
            <Field label={`${t('admin.threshold')} (${currency})`} htmlFor={`th-${corridorId}`}>
                <Input id={`th-${corridorId}`} name="reviewThreshold" defaultValue={threshold} inputMode="decimal" />
            </Field>
            <SubmitButton size="sm">{t('common.save')}</SubmitButton>
        </ActionForm>
    );
}

export function SecurityForm({ cooling, mfa }: { cooling: number; mfa: number }) {
    const { t } = useI18n();
    return (
        <ActionForm action={updateSecurityAction} successMessage={t('common.success')} className="grid gap-4 sm:grid-cols-2">
            <Field label={t('admin.cooling')} htmlFor="sec-cool">
                <Input id="sec-cool" name="payoutAccountCoolingOffHours" type="number" min={24} max={720} defaultValue={cooling} />
            </Field>
            <Field label={t('admin.mfaWindow')} htmlFor="sec-mfa">
                <Input id="sec-mfa" name="sensitiveActionMfaMaxAgeMinutes" type="number" min={1} max={60} defaultValue={mfa} />
            </Field>
            <div className="sm:col-span-2">
                <SubmitButton>{t('common.save')}</SubmitButton>
            </div>
        </ActionForm>
    );
}

export function ResetDemo() {
    const { t } = useI18n();
    return (
        <form
            action={resetDemoAction}
            onSubmit={(e) => {
                if (!window.confirm(t('admin.resetDemoConfirm'))) e.preventDefault();
            }}
        >
            <Button type="submit" variant="destructive">
                <RotateCcw aria-hidden /> {t('admin.resetDemo')}
            </Button>
        </form>
    );
}
