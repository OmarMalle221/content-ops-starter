'use client';
import { addPayoutAccountAction } from '@/app/actions/account';
import { CURRENCY_CODES } from '@/domain/money';
import { Alert } from '@/components/ui/alert';
import { Field, Input, Select } from '@/components/ui/form';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';

export function PayoutAccountForm({ owners }: { owners: { value: string; label: string }[] }) {
    const { t } = useI18n();
    return (
        <ActionForm action={addPayoutAccountAction} successMessage={t('common.success')} resetOnSuccess className="space-y-4">
            <Alert tone="warning">{t('settings.changeWarning')}</Alert>
            <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('settings.owner')} htmlFor="pa-owner">
                    <Select id="pa-owner" name="owner">
                        {owners.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </Select>
                </Field>
                <Field label={t('settings.holder')} htmlFor="pa-holder">
                    <Input id="pa-holder" name="holderName" required maxLength={160} />
                </Field>
                <Field label={t('settings.bank')} htmlFor="pa-bank">
                    <Input id="pa-bank" name="bankName" required maxLength={120} />
                </Field>
                <Field label={t('settings.last4')} htmlFor="pa-last4">
                    <Input id="pa-last4" name="last4" required inputMode="numeric" pattern="\d{4}" maxLength={4} />
                </Field>
                <Field label={t('wizard.currency')} htmlFor="pa-currency">
                    <Select id="pa-currency" name="currency" defaultValue="CAD">
                        {CURRENCY_CODES.map((c) => (
                            <option key={c}>{c}</option>
                        ))}
                    </Select>
                </Field>
                <Field label="Pays" htmlFor="pa-country">
                    <Select id="pa-country" name="country" defaultValue="CA">
                        <option value="CA">Canada</option>
                        <option value="SN">Sénégal</option>
                    </Select>
                </Field>
            </div>
            <SubmitButton>{t('settings.addAccount')}</SubmitButton>
        </ActionForm>
    );
}
