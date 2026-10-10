import { redirect } from 'next/navigation';
import { UserRoundPlus } from 'lucide-react';
import { completeOnboarding } from '@/app/actions/auth';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { Brand } from '@/components/app/brand';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { getI18n } from '@/i18n/server';
import { getActor, pendingOnboarding } from '@/server/auth/session';
import { loadConfig } from '@/server/config';

export const metadata = { title: 'Profil' };

/**
 * Profile creation for a verified Supabase identity without a TrustCargo profile. The page is gated by the signed
 * onboarding marker set by /auth/callback (no Supabase call during render); the action re-checks the identity.
 */
export default async function OnboardingPage() {
    if (loadConfig().auth.provider !== 'supabase') redirect('/');
    if (await getActor()) redirect('/dashboard');
    if (!(await pendingOnboarding())) redirect('/');
    const { t, locale } = await getI18n();
    return (
        <main id="main" className="mx-auto flex min-h-[80dvh] max-w-lg flex-col justify-center gap-6 px-4 py-10">
            <Brand className="self-center" />
            <Card>
                <CardContent className="space-y-5 py-6">
                    <div className="space-y-1 text-center">
                        <UserRoundPlus className="mx-auto size-8 text-primary" aria-hidden />
                        <h1 className="text-lg font-semibold">{t('onboarding.title')}</h1>
                        <p className="text-sm text-muted-foreground">{t('onboarding.subtitle')}</p>
                    </div>
                    <ActionForm action={completeOnboarding} className="space-y-4">
                        <p className="text-xs text-muted-foreground">{t('onboarding.emailNote')}</p>
                        <Field label={t('onboarding.fullName')} htmlFor="fullName">
                            <Input id="fullName" name="fullName" autoComplete="name" minLength={2} maxLength={200} required />
                        </Field>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label={t('onboarding.country')} htmlFor="country" hint={t('onboarding.countryHint')}>
                                <Input
                                    id="country"
                                    name="country"
                                    autoComplete="country"
                                    pattern="[A-Za-z]{2}"
                                    minLength={2}
                                    maxLength={2}
                                    required
                                    aria-describedby="country-hint"
                                    className="uppercase"
                                />
                            </Field>
                            <Field label={`${t('onboarding.city')} (${t('common.optional')})`} htmlFor="city">
                                <Input id="city" name="city" autoComplete="address-level2" maxLength={100} />
                            </Field>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label={`${t('onboarding.phone')} (${t('common.optional')})`} htmlFor="phone">
                                <Input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={20} />
                            </Field>
                            <Field label={t('onboarding.locale')} htmlFor="locale">
                                <Select id="locale" name="locale" defaultValue={locale}>
                                    <option value="fr">{t('onboarding.localeFr')}</option>
                                    <option value="en">{t('onboarding.localeEn')}</option>
                                </Select>
                            </Field>
                        </div>
                        <SubmitButton className="w-full">{t('onboarding.submit')}</SubmitButton>
                    </ActionForm>
                    <p className="text-xs text-muted-foreground">{t('onboarding.rolesNote')}</p>
                    <Alert tone="warning">
                        <p>{t('app.demoBannerDetail')}</p>
                        <p className="mt-1 font-medium">{t('app.notABank')}</p>
                    </Alert>
                </CardContent>
            </Card>
        </main>
    );
}
