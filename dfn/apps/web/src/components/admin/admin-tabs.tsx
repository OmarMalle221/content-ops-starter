'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

export function AdminTabs({ role }: { role: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const tabs = [
    { href: '/admin', key: 'admin.stats' },
    ...(role === 'ADMIN' ? [{ href: '/admin/users', key: 'admin.users' }] : []),
    { href: '/admin/verifications', key: 'admin.verifications' },
    { href: '/admin/disputes', key: 'admin.disputes' },
    { href: '/admin/risk', key: 'admin.risk' },
    { href: '/admin/transfers', key: 'admin.transfers' },
    { href: '/admin/ledger', key: 'admin.ledger' },
    { href: '/admin/audit', key: 'admin.audit' },
    { href: '/admin/jobs', key: 'admin.jobs' },
    ...(role === 'ADMIN' ? [{ href: '/admin/dda', key: 'admin.dda' }] : []),
  ];
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" aria-label="Admin">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
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
