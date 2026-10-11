'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeftRight,
  Bell,
  Briefcase,
  Code2,
  FileText,
  LayoutDashboard,
  Scale,
  Send,
  Settings,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import { cn } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

const items = [
  { href: '/dashboard', key: 'nav.dashboard', icon: LayoutDashboard },
  { href: '/transactions', key: 'nav.transactions', icon: ArrowLeftRight },
  { href: '/wallet', key: 'nav.wallet', icon: Wallet },
  { href: '/transfers', key: 'nav.transfers', icon: Send },
  { href: '/business', key: 'nav.business', icon: Briefcase },
  { href: '/documents', key: 'nav.documents', icon: FileText },
  { href: '/disputes', key: 'nav.disputes', icon: Scale },
  { href: '/developers', key: 'nav.developers', icon: Code2 },
  { href: '/notifications', key: 'nav.notifications', icon: Bell },
  { href: '/settings', key: 'nav.settings', icon: Settings },
];

export function SidebarNav({
  staff,
  unread,
  onNavigate,
}: {
  staff: boolean;
  unread: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { t } = useI18n();
  const all = staff ? [...items, { href: '/admin', key: 'nav.admin', icon: ShieldAlert }] : items;
  return (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {all.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span className="flex-1">{t(item.key)}</span>
            {item.href === '/notifications' && unread > 0 ? (
              <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-foreground">
                {unread}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
