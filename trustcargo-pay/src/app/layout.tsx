import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { I18nProvider } from '@/components/app/i18n-provider';
import { DemoBanner } from '@/components/app/layout-bits';
import { getI18n } from '@/i18n/server';
import { loadConfig } from '@/server/config';
import './globals.css';

export const metadata: Metadata = {
    title: { default: 'TrustCargo Pay', template: '%s · TrustCargo Pay' },
    description: 'Infrastructure de confiance transactionnelle — démonstration sans fonds réels.',
    robots: { index: false, follow: false }
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2b2f6b' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const { locale, dict } = await getI18n();
    const config = loadConfig();
    return (
        <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`}>
            <body className="min-h-dvh font-sans">
                <a
                    href="#main"
                    className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow"
                >
                    {dict.app.skipToContent}
                </a>
                {config.mode === 'demo' && <DemoBanner label={dict.app.demoBanner} detail={dict.app.demoBannerDetail} />}
                <I18nProvider locale={locale} dict={dict}>
                    {children}
                </I18nProvider>
            </body>
        </html>
    );
}
