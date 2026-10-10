'use client';
import * as React from 'react';
import { Check, FilePenLine, X } from 'lucide-react';
import { amendContractAction, decideContractAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { ConfirmAction } from '@/components/app/confirm-action';
import { useI18n } from '@/components/app/i18n-provider';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { CURRENCY_CODES, fromDTO, toDecimalString } from '@/domain/money';
import type { ContractTerms } from '@/domain/model';
import { fromMilestoneTerms, MilestonesEditor, TermsFields, toMilestoneTerms, type EditableTerms } from './contract-editor';

export function ContractDecision({
    transactionId,
    versionId,
    contentHash,
    versionNumber
}: {
    transactionId: string;
    versionId: string;
    contentHash: string;
    versionNumber: number;
}) {
    const { t } = useI18n();
    const hidden = { transactionId, contractVersionId: versionId, contentHash };
    return (
        <div className="flex flex-wrap gap-2">
            <ConfirmAction
                action={decideContractAction}
                hidden={{ ...hidden, decision: 'ACCEPTED' }}
                trigger={
                    <>
                        <Check aria-hidden /> {t('contract.accept')}
                    </>
                }
                title={t('contract.accept')}
                description={t('contract.acceptConfirm', { n: versionNumber })}
                confirmLabel={t('contract.accept')}
                variant="success"
            />
            <ConfirmAction
                action={decideContractAction}
                hidden={{ ...hidden, decision: 'DECLINED' }}
                trigger={
                    <>
                        <X aria-hidden /> {t('contract.decline')}
                    </>
                }
                triggerVariant="secondary"
                title={t('contract.decline')}
                confirmLabel={t('contract.decline')}
                variant="destructive"
            >
                <Field label={t('contract.declineComment')} htmlFor="decline-comment">
                    <Textarea id="decline-comment" name="comment" required minLength={3} maxLength={1000} />
                </Field>
            </ConfirmAction>
        </div>
    );
}

export function AmendContract({
    transactionId,
    terms,
    currencies
}: {
    transactionId: string;
    terms: ContractTerms;
    currencies?: string[];
}) {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const { totalAmount, milestones, ...rest } = terms;
    const [editable, setEditable] = React.useState<EditableTerms>(rest);
    const [ms, setMs] = React.useState(fromMilestoneTerms(milestones));
    const [amount, setAmount] = React.useState(toDecimalString(fromDTO(totalAmount)));
    const [currency, setCurrency] = React.useState<string>(totalAmount.currency);
    const [summary, setSummary] = React.useState('');
    const payload = JSON.stringify({
        price: { amount, currency },
        terms: editable,
        milestones: toMilestoneTerms(ms),
        changeSummary: summary
    });
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="secondary">
                    <FilePenLine aria-hidden /> {t('contract.amend')}
                </Button>
            </DialogTrigger>
            <DialogContent
                title={t('contract.amend')}
                description={t('contract.amendHelp')}
                className="max-w-3xl"
                closeLabel={t('common.close')}
            >
                <ActionForm action={amendContractAction} onSuccess={() => setOpen(false)} className="space-y-5">
                    <input type="hidden" name="transactionId" value={transactionId} />
                    <input type="hidden" name="payload" value={payload} />
                    <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                        <Field label={t('wizard.price')} htmlFor="amend-amount">
                            <Input id="amend-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                        </Field>
                        <Field label={t('wizard.currency')} htmlFor="amend-currency">
                            <Select id="amend-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                                {(currencies ?? CURRENCY_CODES).map((c) => (
                                    <option key={c}>{c}</option>
                                ))}
                            </Select>
                        </Field>
                    </div>
                    <Field label={t('contract.changeSummary')} htmlFor="amend-summary">
                        <Textarea id="amend-summary" value={summary} required onChange={(e) => setSummary(e.target.value)} />
                    </Field>
                    <TermsFields value={editable} onChange={setEditable} idPrefix="amend" />
                    <MilestonesEditor value={ms} onChange={setMs} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <SubmitButton>{t('common.save')}</SubmitButton>
                    </div>
                </ActionForm>
            </DialogContent>
        </Dialog>
    );
}
