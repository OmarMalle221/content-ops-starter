import { Logo } from '@/components/logo';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { getT } from '@/lib/i18n-server';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { t } = await getT();
  return (
    <main className="container flex min-h-[calc(100vh-2rem)] flex-col">
      <header className="flex h-16 items-center justify-between">
        <Logo />
        <LocaleSwitcher />
      </header>
      <div className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-md animate-fade-in">{children}</div>
      </div>
      <p className="pb-6 text-center text-xs text-muted-foreground">{t('app.sandboxLong')}</p>
    </main>
  );
}
