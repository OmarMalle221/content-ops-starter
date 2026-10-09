'use client';
import * as React from 'react';
import { ChevronDown, Upload } from 'lucide-react';
import { uploadDocumentAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { useI18n } from '@/components/app/i18n-provider';
import { Field, Input, Select } from '@/components/ui/form';
import { CURRENCY_CODES } from '@/domain/money';
import type { DocumentType } from '@/domain/model';

const REF_FIELDS: Partial<Record<DocumentType, string[]>> = {
    TITLE: ['vin', 'ownerName', 'documentNumber'],
    INVOICE: ['vin', 'amount', 'amountCurrency', 'documentNumber', 'issueDate'],
    INSPECTION_REPORT: ['vin', 'documentNumber', 'issueDate'],
    BILL_OF_LADING: ['vin', 'consignee', 'shipper', 'portOfLoading', 'portOfDischarge', 'documentNumber'],
    EXPORT_DECLARATION: ['vin', 'amount', 'amountCurrency', 'documentNumber'],
    DELIVERY_PROOF: ['vin', 'consignee', 'issueDate']
};

export function UploadDocumentForm({
    transactionId,
    types,
    milestones,
    myDocuments,
    defaultMilestoneId,
    defaultType
}: {
    transactionId: string;
    types: DocumentType[];
    milestones: { id: string; title: string }[];
    myDocuments: { id: string; type: DocumentType; title: string; version: number }[];
    defaultMilestoneId?: string;
    defaultType?: DocumentType;
}) {
    const { t } = useI18n();
    const [type, setType] = React.useState<DocumentType>(defaultType ?? types[0]!);
    const refs = REF_FIELDS[type] ?? ['documentNumber'];
    return (
        <ActionForm action={uploadDocumentAction} successMessage={t('common.success')} resetOnSuccess className="space-y-4">
            <input type="hidden" name="transactionId" value={transactionId} />
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('documents.type')} htmlFor={`doc-type-${transactionId}`}>
                    <Select
                        id={`doc-type-${transactionId}`}
                        name="type"
                        value={type}
                        onChange={(e) => setType(e.target.value as DocumentType)}
                    >
                        {types.map((ty) => (
                            <option key={ty} value={ty}>
                                {t(`documentType.${ty}`)}
                            </option>
                        ))}
                    </Select>
                </Field>
                <Field label={t('documents.title')} htmlFor="doc-title">
                    <Input id="doc-title" name="title" required maxLength={160} defaultValue={t(`documentType.${type}`)} key={type} />
                </Field>
                <Field label={t('documents.file')} htmlFor="doc-file" className="sm:col-span-2">
                    <Input
                        id="doc-file"
                        name="file"
                        type="file"
                        required
                        accept="application/pdf,image/png,image/jpeg,image/webp"
                        className="h-auto py-1.5 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-sm"
                    />
                </Field>
                {milestones.length > 0 && (
                    <Field label={t('documents.milestone')} htmlFor="doc-milestone">
                        <Select id="doc-milestone" name="milestoneId" defaultValue={defaultMilestoneId ?? ''}>
                            <option value="">—</option>
                            {milestones.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.title}
                                </option>
                            ))}
                        </Select>
                    </Field>
                )}
                {myDocuments.filter((d) => d.type === type).length > 0 && (
                    <Field label={t('documents.replaces')} htmlFor="doc-replaces">
                        <Select id="doc-replaces" name="replacesDocumentId" defaultValue="">
                            <option value="">—</option>
                            {myDocuments
                                .filter((d) => d.type === type)
                                .map((d) => (
                                    <option key={d.id} value={d.id}>
                                        {d.title} (v{d.version})
                                    </option>
                                ))}
                        </Select>
                    </Field>
                )}
            </div>
            <details className="group rounded-md border bg-muted/30">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium">
                    {t('documents.declared')}
                    <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="space-y-3 border-t p-3">
                    <p className="text-xs text-muted-foreground">{t('documents.declaredHint')}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                        {refs.map((f) =>
                            f === 'amountCurrency' ? (
                                <Field key={f} label={t(`documents.extractedFields.${f}`)} htmlFor={`x-${f}`}>
                                    <Select id={`x-${f}`} name={`x_${f}`} defaultValue="CAD">
                                        {CURRENCY_CODES.map((c) => (
                                            <option key={c}>{c}</option>
                                        ))}
                                    </Select>
                                </Field>
                            ) : (
                                <Field key={f} label={t(`documents.extractedFields.${f}`)} htmlFor={`x-${f}`}>
                                    <Input
                                        id={`x-${f}`}
                                        name={`x_${f}`}
                                        maxLength={f === 'vin' ? 17 : 160}
                                        inputMode={f === 'amount' ? 'decimal' : undefined}
                                    />
                                </Field>
                            )
                        )}
                    </div>
                </div>
            </details>
            <SubmitButton>
                <Upload aria-hidden /> {t('documents.upload')}
            </SubmitButton>
        </ActionForm>
    );
}
