import { redirect } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { prepareMfa, verifyMfa } from '@/app/actions/auth';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { Brand } from '@/components/app/brand';
import { ProviderMfa } from '@/components/app/provider-mfa';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { getI18n } from '@/i18n/server';
import { getActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';
import { safeRedirectPath } from '@/server/security/redirect';
import { totp } from '@/server/security/totp';

export const metadata = { title: 'MFA' };

/**
 * Step-up MFA. Demo personas: local TOTP with a fictitious secret. Real users: Supabase TOTP, driven entirely by
 * server actions (this render never calls Supabase, so a token refresh can always be written back to cookies).
 */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
    const actor = await getActor();
    if (!actor) redirect('/');
    const { t } = await getI18n();
    const next = safeRedirectPath((await searchParams).next) ?? '/dashboard';
    const app = await getApp();
    const user = await app.deps.uow.run((db) => db.users.get(actor.userId));
    const localSecret = user?.isDemo ? user.mfaTotpSecret : undefined;
    const demoCode = app.config.mode === 'demo' && localSecret ? totp(localSecret) : undefined;
    const providerMfa = !localSecret && app.config.auth.provider === 'supabase';
    return (
        <main id="main" className="mx-auto flex min-h-[80dvh] max-w-md flex-col justify-center gap-6 px-4 py-10">
            <Brand className="self-center" />
            <Card>
                <CardContent className="space-y-5 py-6">
                    <div className="space-y-1 text-center">
                        <KeyRound className="mx-auto size-8 text-primary" aria-hidden />
                        <h1 className="text-lg font-semibold">{t('mfa.title')}</h1>
                        <p className="text-sm text-muted-foreground">{t('mfa.subtitle')}</p>
                    </div>
                    {localSecret ? (
                        <ActionForm action={verifyMfa} className="space-y-4">
                            <input type="hidden" name="next" value={next} />
                            <Field label={t('mfa.code')} htmlFor="code">
                                <Input
                                    id="code"
                                    name="code"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    pattern="\d{6}"
                                    maxLength={6}
                                    required
                                    autoFocus
                                    className="text-center font-mono text-lg tracking-[0.5em]"
                                />
                            </Field>
                            <SubmitButton className="w-full">{t('mfa.verify')}</SubmitButton>
                        </ActionForm>
                    ) : providerMfa ? (
                        <ProviderMfa next={next} prepare={prepareMfa} verify={verifyMfa} />
                    ) : (
                        <Alert tone="warning">{t('mfa.unavailable')}</Alert>
                    )}
                    <p className="text-xs text-muted-foreground">{t('mfa.why')}</p>
                    {demoCode && (
                        <Alert tone="warning" title={t('mfa.demoHint')}>
                            <span className="font-mono text-base tracking-widest" data-testid="demo-totp">
                                {demoCode}
                            </span>
                        </Alert>
                    )}
                </CardContent>
            </Card>
        </main>
    );
}
