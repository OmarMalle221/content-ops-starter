'use client';
import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/components/app/i18n-provider';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/form';
import type { ContractTerms, DocumentType, MilestoneTerm } from '@/domain/model';
import { fmtPct } from '@/lib/format';
import { cn } from '@/lib/cn';

export type EditableTerms = Omit<ContractTerms, 'totalAmount' | 'milestones'>;
export interface EditableMilestone extends Omit<MilestoneTerm, 'shareBps'> {
    percent: string;
}

export const EVIDENCE_TYPES: DocumentType[] = [
    'INSPECTION_REPORT',
    'TITLE',
    'INVOICE',
    'PHOTO',
    'BILL_OF_LADING',
    'EXPORT_DECLARATION',
    'DELIVERY_PROOF'
];

export function percentToBps(p: string): number {
    const n = p.trim().replace(',', '.');
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(n)) return NaN;
    const [i, f = ''] = n.split('.');
    return Number(i) * 100 + Number(f.padEnd(2, '0'));
}

export function toMilestoneTerms(ms: EditableMilestone[]): MilestoneTerm[] {
    return ms.map(({ percent, ...m }, i) => ({ ...m, key: m.key || `m-${i + 1}`, shareBps: percentToBps(percent) }));
}

export function fromMilestoneTerms(ms: MilestoneTerm[]): EditableMilestone[] {
    return ms.map(({ shareBps, ...m }) => ({ ...m, percent: String(shareBps / 100) }));
}

const TERM_FIELDS = [
    'goodsDescription',
    'sellerResponsibilities',
    'buyerResponsibilities',
    'inspectionTerms',
    'shippingTerms',
    'deliveryTerms',
    'releaseTerms',
    'refundTerms',
    'disputeProcedure'
] as const;

export function TermsFields({
    value,
    onChange,
    idPrefix = 'terms'
}: {
    value: EditableTerms;
    onChange: (v: EditableTerms) => void;
    idPrefix?: string;
}) {
    const { t } = useI18n();
    return (
        <div className="grid gap-4 sm:grid-cols-2">
            {TERM_FIELDS.map((f) => (
                <Field
                    key={f}
                    label={t(`contract.fields.${f}`)}
                    htmlFor={`${idPrefix}-${f}`}
                    className={f === 'goodsDescription' ? 'sm:col-span-2' : ''}
                >
                    <Textarea
                        id={`${idPrefix}-${f}`}
                        value={value[f]}
                        required
                        maxLength={4000}
                        onChange={(e) => onChange({ ...value, [f]: e.target.value })}
                        rows={f === 'goodsDescription' ? 3 : 2}
                    />
                </Field>
            ))}
            <fieldset className="grid grid-cols-2 gap-3 sm:col-span-2 sm:grid-cols-4">
                <legend className="mb-2 text-sm font-medium">{t('contract.fields.deadlines')}</legend>
                {(['inspectionDays', 'shippingDays', 'deliveryDays', 'reviewDays'] as const).map((k) => (
                    <Field
                        key={k}
                        label={t(`contract.deadlines.${k}`, { n: '' }).replace(/[:：]?\s*j?d?$/, '')}
                        htmlFor={`${idPrefix}-${k}`}
                    >
                        <Input
                            id={`${idPrefix}-${k}`}
                            type="number"
                            min={1}
                            max={365}
                            value={value.deadlines[k]}
                            onChange={(e) => onChange({ ...value, deadlines: { ...value.deadlines, [k]: Number(e.target.value) } })}
                        />
                    </Field>
                ))}
            </fieldset>
        </div>
    );
}

export function MilestonesEditor({
    value,
    onChange,
    totalLabel
}: {
    value: EditableMilestone[];
    onChange: (v: EditableMilestone[]) => void;
    totalLabel?: string;
}) {
    const { t, intl } = useI18n();
    const total = value.reduce((a, m) => a + (percentToBps(m.percent) || 0), 0);
    const update = (i: number, patch: Partial<EditableMilestone>) => onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    return (
        <div className="space-y-4">
            {value.map((m, i) => (
                <fieldset key={i} className="space-y-3 rounded-lg border bg-muted/30 p-4">
                    <legend className="sr-only">
                        {t('wizard.milestoneTitle')} {i + 1}
                    </legend>
                    <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
                        <Field label={`${i + 1}. ${t('wizard.milestoneTitle')}`} htmlFor={`m-title-${i}`}>
                            <Input
                                id={`m-title-${i}`}
                                value={m.title}
                                required
                                maxLength={120}
                                onChange={(e) => update(i, { title: e.target.value })}
                            />
                        </Field>
                        <Field label={t('wizard.percent')} htmlFor={`m-pct-${i}`}>
                            <Input
                                id={`m-pct-${i}`}
                                inputMode="decimal"
                                value={m.percent}
                                aria-invalid={Number.isNaN(percentToBps(m.percent))}
                                onChange={(e) => update(i, { percent: e.target.value })}
                            />
                        </Field>
                    </div>
                    <Field label={t('wizard.milestoneDescription')} htmlFor={`m-desc-${i}`}>
                        <Textarea
                            id={`m-desc-${i}`}
                            rows={2}
                            value={m.description}
                            maxLength={1000}
                            onChange={(e) => update(i, { description: e.target.value })}
                        />
                    </Field>
                    <div>
                        <p className="mb-2 text-sm font-medium">{t('wizard.requiredEvidence')}</p>
                        <div className="flex flex-wrap gap-2">
                            {EVIDENCE_TYPES.map((type) => {
                                const on = m.requiredEvidence.includes(type);
                                return (
                                    <label
                                        key={type}
                                        className={cn(
                                            'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
                                            on ? 'border-primary bg-primary-soft text-primary' : 'bg-card'
                                        )}
                                    >
                                        <input
                                            type="checkbox"
                                            className="sr-only"
                                            checked={on}
                                            onChange={() =>
                                                update(i, {
                                                    requiredEvidence: on
                                                        ? m.requiredEvidence.filter((x) => x !== type)
                                                        : [...m.requiredEvidence, type]
                                                })
                                            }
                                        />
                                        {t(`documentType.${type}`)}
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                    {value.length > 1 && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                            <Trash2 aria-hidden /> {t('wizard.removeMilestone')}
                        </Button>
                    )}
                </fieldset>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={value.length >= 10}
                    onClick={() =>
                        onChange([...value, { key: `m-${Date.now()}`, title: '', description: '', percent: '0', requiredEvidence: [] }])
                    }
                >
                    <Plus aria-hidden /> {t('wizard.addMilestone')}
                </Button>
                <p
                    className={cn('text-sm font-medium tabular', total === 10_000 ? 'text-success' : 'text-danger')}
                    role="status"
                    data-testid="milestone-total"
                >
                    {totalLabel ?? t('milestone.sum')} : {fmtPct(total, intl)}
                </p>
            </div>
        </div>
    );
}
