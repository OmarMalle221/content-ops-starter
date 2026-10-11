import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { SandboxBanner } from '@dfn/ui';
import { I18nProvider } from '@/lib/i18n-client';
import { getT } from '@/lib/i18n-server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Diaspora Trust — Sandbox', template: '%s · Diaspora Trust (sandbox)' },
  description:
    'Diaspora Financial Network — trusted financial infrastructure connecting Africa and its diaspora. Sandbox: simulated data, no real funds.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f4c54' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, t } = await getT();
  return (
    <html lang={locale} className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <I18nProvider locale={locale}>
          <SandboxBanner text={t('app.sandbox')} />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
