import { redirect } from 'next/navigation';
import { Lock } from 'lucide-react';
import { loginAsPersona, requestMagicLink } from '@/app/actions/auth';
import { Brand } from '@/components/app/brand';
import { EmailSignIn } from '@/components/app/email-sign-in';
import { LocaleSwitch } from '@/components/app/locale-switch';
import { PersonaPicker } from '@/components/app/persona-picker';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getI18n } from '@/i18n/server';
import { getActor } from '@/server/auth/session';
import { loadConfig } from '@/server/config';
import { PERSONAS } from '@/server/demo/personas';

export default async function Home({ searchParams }: { searchParams: Promise<{ auth?: string }> }) {
    const actor = await getActor();
    if (actor) redirect(actor.platformRoles.length ? '/admin' : '/dashboard');
    const { t, locale, dict } = await getI18n();
    const config = loadConfig();
    const { auth } = await searchParams;
    // Either e-mail sign-in (Supabase Auth, real accounts) or the persona picker (persona demo), never both:
    // persona login requires AUTH_PROVIDER=demo, and a database never holds personas next to real accounts.
    const emailSignIn = config.auth.provider === 'supabase';
    return (
        <div className="min-h-dvh bg-gradient-to-b from-primary-soft/60 to-background">
            <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
                <Brand />
                <LocaleSwitch locale={locale} label={t('nav.language')} back="/" />
            </header>
            <main id="main" className="mx-auto grid max-w-6xl gap-10 px-4 pt-6 pb-16 lg:grid-cols-[1.1fr_1fr] lg:pt-12">
                <section className="space-y-8">
                    <div className="space-y-4">
                        <p className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                            <Lock className="size-3.5" aria-hidden /> {t('app.tagline')} · Canada → Sénégal
                        </p>
                        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl">{t('landing.title')}</h1>
                        <p className="max-w-xl text-base text-muted-foreground sm:text-lg">{t('landing.subtitle')}</p>
                    </div>
                    <div>
                        <h2 className="mb-3 text-sm font-semibold">{t('landing.how')}</h2>
                        <ol className="grid gap-3 sm:grid-cols-2">
                            {dict.landing.steps.map(([title, text], i) => (
                                <li key={title} className="flex gap-3 rounded-lg border bg-card/80 p-3">
                                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                                        {i + 1}
                                    </span>
                                    <span>
                                        <span className="block text-sm font-medium">{title}</span>
                                        <span className="block text-xs text-muted-foreground">{text}</span>
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </div>
                    <Alert tone="warning" title={t('landing.disclaimerTitle')}>
                        <p>{t('landing.disclaimer')}</p>
                        <p className="mt-1 font-medium">{t('app.notABank')}</p>
                    </Alert>
                </section>
                <div className="space-y-6 self-start">
                    {(auth === 'error' || auth === 'expired') && (
                        <Alert tone={auth === 'error' ? 'danger' : 'warning'}>{t(auth === 'error' ? 'auth.error' : 'auth.expired')}</Alert>
                    )}
                    {emailSignIn && (
                        <Card>
                            <CardHeader className="block">
                                <CardTitle className="text-base">{t('auth.signInTitle')}</CardTitle>
                                <p className="text-sm text-muted-foreground">{t('auth.signInHelp')}</p>
                            </CardHeader>
                            <CardContent>
                                <EmailSignIn action={requestMagicLink} />
                            </CardContent>
                        </Card>
                    )}
                    {config.personaLogin && (
                        <Card>
                            <CardHeader className="block">
                                <CardTitle className="text-base">{t('landing.choosePersona')}</CardTitle>
                                <p className="text-sm text-muted-foreground">{t('landing.choosePersonaHelp')}</p>
                            </CardHeader>
                            <CardContent>
                                <PersonaPicker
                                    action={loginAsPersona}
                                    personas={PERSONAS.map((p) => ({
                                        key: p.key,
                                        fullName: p.fullName,
                                        headline: p.headline[locale],
                                        city: p.city,
                                        country: p.country,
                                        staff: p.platformRoles.length > 0
                                    }))}
                                />
                            </CardContent>
                        </Card>
                    )}
                    {!emailSignIn && !config.personaLogin && <Alert tone="info">{t('auth.notConfigured')}</Alert>}
                </div>
            </main>
        </div>
    );
}
