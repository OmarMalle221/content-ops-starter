import Link from 'next/link';
import { ArrowRight, FileCheck2, Landmark, Scale, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent } from '@dfn/ui';
import { Logo } from '@/components/logo';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export default async function LandingPage() {
  const { t } = await getT();
  const session = await getSession();
  const steps = [
    { icon: <ShieldCheck />, text: t('landing.step1') },
    { icon: <FileCheck2 />, text: t('landing.step2') },
    { icon: <Landmark />, text: t('landing.step3') },
    { icon: <Scale />, text: t('landing.step4') },
  ];
  return (
    <main className="min-h-screen">
      <header className="container flex h-16 items-center justify-between">
        <Logo />
        <nav className="flex items-center gap-2">
          <LocaleSwitcher />
          {session ? (
            <Button asChild>
              <Link href="/dashboard">{t('nav.dashboard')}</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost">
                <Link href="/login">{t('auth.login')}</Link>
              </Button>
              <Button asChild>
                <Link href="/register">{t('auth.register')}</Link>
              </Button>
            </>
          )}
        </nav>
      </header>
      <section className="container grid gap-10 py-16 lg:grid-cols-2 lg:items-center lg:py-24">
        <div className="animate-fade-in">
          <p className="mb-4 inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            Diaspora Financial Network · Canada → Sénégal
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            {t('landing.hero')}
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted-foreground">{t('landing.sub')}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href={session ? '/dashboard' : '/register'}>
                {t('landing.cta')} <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">{t('auth.login')}</Link>
            </Button>
          </div>
          <p className="mt-6 text-xs text-muted-foreground">{t('app.sandboxLong')}</p>
        </div>
        <Card className="animate-fade-in">
          <CardContent className="p-6">
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('landing.how')}
            </h2>
            <ol className="space-y-4">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-5">
                    {s.icon}
                  </span>
                  <p className="pt-1.5 text-sm leading-relaxed">{s.text}</p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </section>
      <footer className="container border-t py-8 text-xs text-muted-foreground">
        <p>
          © {new Date().getFullYear()} Diaspora Financial Network — {t('app.tagline')}
        </p>
        <p className="mt-1">{t('app.sandbox')}</p>
      </footer>
    </main>
  );
}
