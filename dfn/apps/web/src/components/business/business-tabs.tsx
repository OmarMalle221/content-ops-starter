'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

/** Diaspora Business navigation: links (server-rendered pages), the organisation travels in the query string. */
export function BusinessTabs({
  organizationId,
  canViewReports,
}: {
  organizationId: string;
  canViewReports: boolean;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const qs = `?organizationId=${organizationId}`;
  const tabs = [
    { href: '/business', key: 'bizTabs.overview', exact: true },
    { href: '/business/clients', key: 'bizTabs.clients' },
    { href: '/business/quotes', key: 'bizTabs.quotes' },
    { href: '/business/invoices', key: 'bizTabs.invoices' },
    ...(canViewReports ? [{ href: '/business/reports', key: 'bizTabs.reports' }] : []),
    { href: '/business/team', key: 'bizTabs.team' },
  ];
  return (
    <nav className="mb-6 flex flex-wrap gap-1 rounded-lg bg-muted p-1" aria-label="Diaspora Business">
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={`${tab.href}${qs}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium',
              active ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
