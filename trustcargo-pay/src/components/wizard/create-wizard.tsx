'use client';
import Link from 'next/link';
import * as React from 'react';
import { ArrowLeft, ArrowRight, Car, CheckCircle2, Package, Wrench } from 'lucide-react';
import { createTransactionAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { useI18n } from '@/components/app/i18n-provider';
import { KeyValue } from '@/components/app/layout-bits';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/form';
import { checkVin } from '@/domain/vehicle/vin';
import { formatMoney, parseMoney, type CurrencyCode } from '@/domain/money';
import { fmtPct } from '@/lib/format';
import { cn } from '@/lib/cn';
import { createVehicleTransactionSchema, personSchema, vehicleSchema } from '@/lib/validation/schemas';
import { defaultMilestones, defaultTerms } from '@/lib/default-terms';
import type { ActionState } from '@/lib/action-state';
import {
    fromMilestoneTerms,
    MilestonesEditor,
    percentToBps,
    TermsFields,
    toMilestoneTerms,
    type EditableTerms
} from '@/components/tx/contract-editor';
import { InviteLinks } from '@/components/tx/invite-links';

interface Props {
    organizations: { id: string; legalName: string }[];
    currencies: string[];
    kycVerified: boolean;
}

type Result = { id: string; links: { role: string; email: string; url: string }[] };

export function CreateWizard({ organizations, currencies, kycVerified }: Props) {
    const { t, locale, dict, intl } = useI18n();
    const [step, setStep] = React.useState(0);
    const [errors, setErrors] = React.useState<Record<string, string>>({});
    const [vehicle, setVehicle] = React.useState({
        make: '',
        model: '',
        year: '',
        vin: '',
        mileageKm: '',
        declaredCondition: 'GOOD',
        conditionNotes: '',
        exteriorColor: '',
        originCountry: 'CA',
        destinationCountry: 'SN'
    });
    const [price, setPrice] = React.useState({ amount: '', currency: 'CAD' });
    const [orgId, setOrgId] = React.useState(organizations[0]?.id ?? '');
    const [buyer, setBuyer] = React.useState({ fullName: '', email: '', phone: '', companyName: '' });
    const [withInspector, setWithInspector] = React.useState(false);
    const [inspector, setInspector] = React.useState({ fullName: '', email: '', phone: '', companyName: '' });
    const [terms, setTerms] = React.useState<EditableTerms | null>(null);
    const [milestones, setMilestones] = React.useState(fromMilestoneTerms(defaultMilestones(locale)));
    const [acceptTerms, setAcceptTerms] = React.useState(true);
    const [result, setResult] = React.useState<Result>();
    const headingRef = React.useRef<HTMLHeadingElement>(null);

    React.useEffect(() => headingRef.current?.focus(), [step]);

    const issuesToErrors = (issues: { path: PropertyKey[]; message: string }[], prefix = '') =>
        Object.fromEntries(issues.map((i) => [`${prefix}${i.path.map(String).join('.')}`, i.message]));

    function validate(current: number): boolean {
        let e: Record<string, string> = {};
        if (current === 1) {
            const r = vehicleSchema.safeParse(vehicle);
            if (!r.success) e = issuesToErrors(r.error.issues, 'vehicle.');
            else if (!checkVin(vehicle.vin).structurallyValid)
                e['vehicle.vin'] = `${t('tx.vinBad')} (${checkVin(vehicle.vin).issues.join(', ')})`;
            try {
                if (parseMoney(price.amount || 'x', price.currency as CurrencyCode).amountMinor <= 0n)
                    e['price.amount'] = t('errors.VALIDATION');
            } catch {
                e['price.amount'] = t('errors.VALIDATION');
            }
        }
        if (current === 2) {
            const r = personSchema.safeParse(buyer);
            if (!r.success) e = issuesToErrors(r.error.issues, 'buyer.');
            if (withInspector) {
                const ri = personSchema.safeParse(inspector);
                if (!ri.success) e = { ...e, ...issuesToErrors(ri.error.issues, 'inspector.') };
            }
        }
        if (current === 4) {
            const total = milestones.reduce((a, m) => a + (percentToBps(m.percent) || 0), 0);
            if (total !== 10_000 || milestones.some((m) => !m.title.trim() || !(percentToBps(m.percent) > 0)))
                e['milestones'] = t('guard.MILESTONES_NOT_100_PERCENT');
        }
        setErrors(e);
        return Object.keys(e).length === 0;
    }

    function next() {
        if (!validate(step)) return;
        if (step === 2 && !terms) setTerms(defaultTerms(locale, vehicle));
        setStep((s) => s + 1);
    }

    const payload = terms
        ? {
              vehicle,
              price,
              buyer: { ...buyer, phone: buyer.phone || undefined, companyName: buyer.companyName || undefined },
              inspector: withInspector
                  ? { ...inspector, phone: inspector.phone || undefined, companyName: inspector.companyName || undefined }
                  : undefined,
              sellerOrganizationId: orgId || undefined,
              terms,
              milestones: toMilestoneTerms(milestones)
          }
        : undefined;
    const payloadValid = payload ? createVehicleTransactionSchema.safeParse(payload).success : false;
    const amountLabel = (() => {
        try {
            return formatMoney(parseMoney(price.amount, price.currency as CurrencyCode), intl);
        } catch {
            return '—';
        }
    })();
    const err = (k: string) => errors[k];

    return (
        <div className="space-y-6">
            <ol className="flex gap-1 overflow-x-auto" aria-label={t('wizard.title')}>
                {dict.wizard.steps.map((label, i) => (
                    <li key={label} className="min-w-20 flex-1" aria-current={i === step ? 'step' : undefined}>
                        <div
                            className={cn('h-1 rounded-full', i < step || result ? 'bg-success' : i === step ? 'bg-primary' : 'bg-border')}
                        />
                        <p
                            className={cn(
                                'mt-1.5 truncate text-xs',
                                i === step ? 'font-semibold text-foreground' : 'text-muted-foreground'
                            )}
                        >
                            {i + 1}. {label}
                        </p>
                    </li>
                ))}
            </ol>

            <Card>
                <CardContent className="space-y-6 py-6">
                    <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
                        {dict.wizard.steps[result ? 6 : step]}
                    </h2>

                    {step === 0 && (
                        <div className="grid gap-3 sm:grid-cols-3">
                            <button
                                type="button"
                                className="flex flex-col items-start gap-2 rounded-lg border-2 border-primary bg-primary-soft/50 p-4 text-left"
                                aria-pressed="true"
                            >
                                <Car className="size-6 text-primary" aria-hidden />
                                <span className="font-semibold">{t('wizard.typeVehicle')}</span>
                                <span className="text-sm text-muted-foreground">{t('wizard.typeVehicleHelp')}</span>
                            </button>
                            {[
                                [Package, t('wizard.typeGoods')],
                                [Wrench, t('wizard.typeServices')]
                            ].map(([Icon, label]) => {
                                const I = Icon as typeof Package;
                                return (
                                    <div
                                        key={label as string}
                                        className="flex flex-col items-start gap-2 rounded-lg border border-dashed p-4 opacity-60"
                                        aria-disabled="true"
                                    >
                                        <I className="size-6 text-muted-foreground" aria-hidden />
                                        <span className="font-semibold">{label as string}</span>
                                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t('wizard.typeSoon')}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {step === 1 && (
                        <div className="grid gap-4 sm:grid-cols-2">
                            {(
                                [
                                    ['make', t('wizard.make')],
                                    ['model', t('wizard.model')],
                                    ['year', t('wizard.year')],
                                    ['mileageKm', t('wizard.mileage')]
                                ] as const
                            ).map(([k, label]) => (
                                <Field key={k} label={label} htmlFor={`v-${k}`} error={err(`vehicle.${k}`)}>
                                    <Input
                                        id={`v-${k}`}
                                        value={vehicle[k]}
                                        inputMode={k === 'year' || k === 'mileageKm' ? 'numeric' : undefined}
                                        aria-invalid={Boolean(err(`vehicle.${k}`))}
                                        onChange={(e) => setVehicle({ ...vehicle, [k]: e.target.value })}
                                        required
                                    />
                                </Field>
                            ))}
                            <Field
                                label={t('wizard.vin')}
                                htmlFor="v-vin"
                                error={err('vehicle.vin')}
                                className="sm:col-span-2"
                                hint={t('tx.vinOkHint')}
                            >
                                <Input
                                    id="v-vin"
                                    value={vehicle.vin}
                                    maxLength={17}
                                    className="font-mono uppercase"
                                    aria-invalid={Boolean(err('vehicle.vin'))}
                                    onChange={(e) => setVehicle({ ...vehicle, vin: e.target.value.toUpperCase() })}
                                    required
                                />
                            </Field>
                            <Field label={t('wizard.condition')} htmlFor="v-cond">
                                <Select
                                    id="v-cond"
                                    value={vehicle.declaredCondition}
                                    onChange={(e) => setVehicle({ ...vehicle, declaredCondition: e.target.value })}
                                >
                                    {(['EXCELLENT', 'GOOD', 'FAIR', 'NEEDS_REPAIR'] as const).map((c) => (
                                        <option key={c} value={c}>
                                            {t(`condition.${c}`)}
                                        </option>
                                    ))}
                                </Select>
                            </Field>
                            <Field label={t('wizard.color')} htmlFor="v-color">
                                <Input
                                    id="v-color"
                                    value={vehicle.exteriorColor}
                                    onChange={(e) => setVehicle({ ...vehicle, exteriorColor: e.target.value })}
                                />
                            </Field>
                            <Field label={t('wizard.conditionNotes')} htmlFor="v-notes" className="sm:col-span-2">
                                <Textarea
                                    id="v-notes"
                                    value={vehicle.conditionNotes}
                                    onChange={(e) => setVehicle({ ...vehicle, conditionNotes: e.target.value })}
                                />
                            </Field>
                            <Field label={t('wizard.origin')} htmlFor="v-origin">
                                <Select id="v-origin" value={vehicle.originCountry} disabled>
                                    <option value="CA">Canada</option>
                                </Select>
                            </Field>
                            <Field label={t('wizard.destination')} htmlFor="v-dest">
                                <Select id="v-dest" value={vehicle.destinationCountry} disabled>
                                    <option value="SN">Sénégal</option>
                                </Select>
                            </Field>
                            <Field label={t('wizard.price')} htmlFor="v-price" error={err('price.amount')}>
                                <Input
                                    id="v-price"
                                    inputMode="decimal"
                                    value={price.amount}
                                    aria-invalid={Boolean(err('price.amount'))}
                                    onChange={(e) => setPrice({ ...price, amount: e.target.value })}
                                    required
                                />
                            </Field>
                            <Field label={t('wizard.currency')} htmlFor="v-currency">
                                <Select
                                    id="v-currency"
                                    value={price.currency}
                                    onChange={(e) => setPrice({ ...price, currency: e.target.value })}
                                >
                                    {currencies.map((c) => (
                                        <option key={c}>{c}</option>
                                    ))}
                                </Select>
                            </Field>
                            <p className="text-sm text-muted-foreground sm:col-span-2">{t('wizard.photosLater')}</p>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6">
                            <Field label={t('wizard.sellingAs')} htmlFor="p-org">
                                <Select id="p-org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                                    {organizations.map((o) => (
                                        <option key={o.id} value={o.id}>
                                            {o.legalName}
                                        </option>
                                    ))}
                                    <option value="">{t('wizard.myself')}</option>
                                </Select>
                            </Field>
                            <fieldset className="grid gap-4 sm:grid-cols-2">
                                <legend className="mb-3 text-sm font-semibold">{t('wizard.buyer')}</legend>
                                {(
                                    [
                                        ['fullName', t('wizard.buyerName'), 'name'],
                                        ['email', t('wizard.buyerEmail'), 'email'],
                                        ['phone', `${t('wizard.buyerPhone')} (${t('common.optional')})`, 'tel'],
                                        ['companyName', `${t('wizard.buyerCompany')} (${t('common.optional')})`, 'organization']
                                    ] as const
                                ).map(([k, label, ac]) => (
                                    <Field key={k} label={label} htmlFor={`b-${k}`} error={err(`buyer.${k}`)}>
                                        <Input
                                            id={`b-${k}`}
                                            type={k === 'email' ? 'email' : 'text'}
                                            autoComplete="off"
                                            data-ac={ac}
                                            value={buyer[k]}
                                            aria-invalid={Boolean(err(`buyer.${k}`))}
                                            onChange={(e) => setBuyer({ ...buyer, [k]: e.target.value })}
                                        />
                                    </Field>
                                ))}
                            </fieldset>
                            <label className="flex items-center gap-2 text-sm font-medium">
                                <Checkbox checked={withInspector} onChange={(e) => setWithInspector(e.target.checked)} />{' '}
                                {t('wizard.addInspector')}
                            </label>
                            {withInspector && (
                                <fieldset className="grid gap-4 sm:grid-cols-3">
                                    <legend className="sr-only">{t('partyRole.INSPECTOR')}</legend>
                                    {(
                                        [
                                            ['fullName', t('wizard.inspectorName')],
                                            ['email', t('wizard.inspectorEmail')],
                                            ['companyName', t('wizard.inspectorCompany')]
                                        ] as const
                                    ).map(([k, label]) => (
                                        <Field key={k} label={label} htmlFor={`i-${k}`} error={err(`inspector.${k}`)}>
                                            <Input
                                                id={`i-${k}`}
                                                value={inspector[k]}
                                                onChange={(e) => setInspector({ ...inspector, [k]: e.target.value })}
                                            />
                                        </Field>
                                    ))}
                                </fieldset>
                            )}
                        </div>
                    )}

                    {step === 3 && terms && (
                        <div className="space-y-4">
                            <Alert tone="info">{t('wizard.termsHelp')}</Alert>
                            <TermsFields value={terms} onChange={setTerms} />
                        </div>
                    )}

                    {step === 4 && (
                        <div className="space-y-4">
                            <Alert tone="info">{t('wizard.milestonesHelp')}</Alert>
                            <MilestonesEditor value={milestones} onChange={setMilestones} />
                            {err('milestones') && <Alert tone="danger">{err('milestones')}</Alert>}
                        </div>
                    )}

                    {step === 5 && terms && !result && (
                        <div className="space-y-6">
                            <p className="text-sm text-muted-foreground">{t('wizard.summary')}</p>
                            <KeyValue
                                items={[
                                    { label: t('tx.vehicle'), value: `${vehicle.make} ${vehicle.model} ${vehicle.year}` },
                                    { label: t('tx.vin'), value: <span className="font-mono">{vehicle.vin}</span> },
                                    { label: t('common.amount'), value: amountLabel },
                                    { label: t('tx.route'), value: `${vehicle.originCountry} → ${vehicle.destinationCountry}` },
                                    {
                                        label: t('wizard.seller'),
                                        value: organizations.find((o) => o.id === orgId)?.legalName ?? t('wizard.myself')
                                    },
                                    { label: t('wizard.buyer'), value: `${buyer.fullName} · ${buyer.email}` },
                                    ...(withInspector
                                        ? [{ label: t('partyRole.INSPECTOR'), value: `${inspector.fullName} · ${inspector.email}` }]
                                        : []),
                                    { label: t('contract.fields.shippingTerms'), value: terms.shippingTerms }
                                ]}
                            />
                            <div>
                                <p className="mb-2 text-sm font-medium">{t('contract.fields.milestones')}</p>
                                <ol className="space-y-1 text-sm">
                                    {toMilestoneTerms(milestones).map((m, i) => (
                                        <li key={i}>
                                            {i + 1}. {m.title} — <span className="tabular">{fmtPct(m.shareBps, intl)}</span>
                                        </li>
                                    ))}
                                </ol>
                            </div>
                            <ActionForm
                                action={createTransactionAction}
                                onSuccess={(s: ActionState) => {
                                    setResult(s.data as Result);
                                    setStep(6);
                                }}
                                className="space-y-4"
                            >
                                <input type="hidden" name="payload" value={JSON.stringify(payload)} />
                                <label className="flex items-start gap-2 text-sm">
                                    <Checkbox
                                        name="acceptTerms"
                                        checked={acceptTerms}
                                        onChange={(e) => setAcceptTerms(e.target.checked)}
                                        className="mt-0.5"
                                    />
                                    <span>{t('wizard.acceptTerms')}</span>
                                </label>
                                {!kycVerified && <Alert tone="warning">{t('contract.kycRequired')}</Alert>}
                                <SubmitButton disabled={!payloadValid} data-testid="wizard-create">
                                    <CheckCircle2 aria-hidden /> {t('wizard.create')}
                                </SubmitButton>
                            </ActionForm>
                        </div>
                    )}

                    {result && (
                        <div className="space-y-4">
                            <Alert tone="success" title={t('wizard.created')} />
                            <InviteLinks links={result.links} />
                            <Button asChild>
                                <Link href={`/transactions/${result.id}`}>
                                    {t('wizard.goToTransaction')} <ArrowRight aria-hidden />
                                </Link>
                            </Button>
                        </div>
                    )}
                </CardContent>
            </Card>

            {!result && step < 5 && (
                <div className="flex justify-between gap-2">
                    <Button type="button" variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
                        <ArrowLeft aria-hidden /> {t('common.previous')}
                    </Button>
                    <Button type="button" onClick={next} data-testid="wizard-next">
                        {t('common.next')} <ArrowRight aria-hidden />
                    </Button>
                </div>
            )}
            {!result && step === 5 && (
                <Button type="button" variant="secondary" onClick={() => setStep(4)}>
                    <ArrowLeft aria-hidden /> {t('common.previous')}
                </Button>
            )}
        </div>
    );
}
