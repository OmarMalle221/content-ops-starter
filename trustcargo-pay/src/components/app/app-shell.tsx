'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import {
    Bell,
    BookOpenCheck,
    Building2,
    FileSearch,
    Gavel,
    Globe2,
    LayoutDashboard,
    Landmark,
    LogOut,
    Menu,
    PlusCircle,
    Scale,
    ScrollText,
    Settings,
    ShieldAlert,
    ShieldCheck,
    UserCheck,
    Waypoints,
    X,
    ArrowLeftRight
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Brand } from './brand';

const ICONS = {
    dashboard: LayoutDashboard,
    transactions: ArrowLeftRight,
    new: PlusCircle,
    verification: UserCheck,
    notifications: Bell,
    settings: Settings,
    overview: Globe2,
    verifications: ShieldCheck,
    organizations: Building2,
    risk: ShieldAlert,
    documents: FileSearch,
    disputes: Gavel,
    partners: Landmark,
    ledger: Scale,
    audit: ScrollText,
    corridors: Waypoints,
    security: BookOpenCheck
};
export type NavIcon = keyof typeof ICONS;

export interface NavSection {
    title?: string;
    items: { href: string; label: string; icon: NavIcon; badge?: number }[];
}

export function AppShell({
    sections,
    user,
    signOut,
    signOutLabel,
    menuLabel,
    localeSwitch,
    children
}: {
    sections: NavSection[];
    user: { name: string; subtitle: string };
    signOut: () => Promise<void>;
    signOutLabel: string;
    menuLabel: string;
    localeSwitch: React.ReactNode;
    children: React.ReactNode;
}) {
    const pathname = usePathname();
    // The menu is "open for" a given path, so it closes by itself after navigation (no effect needed).
    const [openFor, setOpenFor] = React.useState<string | null>(null);
    const open = openFor === pathname;

    // Highlight only the most specific matching entry (longest prefix).
    const allHrefs = sections.flatMap((sct) => sct.items.map((i) => i.href));
    const activeHref = allHrefs.filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];

    const nav = (
        <nav aria-label="Navigation principale" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
            {sections.map((section, i) => (
                <div key={i} className="space-y-1">
                    {section.title && (
                        <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-sidebar-muted uppercase">{section.title}</p>
                    )}
                    {section.items.map((item) => {
                        const Icon = ICONS[item.icon];
                        const active = item.href === activeHref;
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                aria-current={active ? 'page' : undefined}
                                className={cn(
                                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-active hover:text-white',
                                    active && 'bg-sidebar-active font-medium text-white'
                                )}
                            >
                                <Icon className="size-4 shrink-0" aria-hidden />
                                <span className="flex-1">{item.label}</span>
                                {item.badge ? (
                                    <span className="rounded-full bg-primary px-1.5 text-[11px] font-semibold text-white tabular">
                                        {item.badge}
                                    </span>
                                ) : null}
                            </Link>
                        );
                    })}
                </div>
            ))}
        </nav>
    );

    const footer = (
        <div className="space-y-2 border-t border-white/10 p-3">
            <div className="px-2">
                <p className="truncate text-sm font-medium text-white">{user.name}</p>
                <p className="truncate text-xs text-sidebar-muted">{user.subtitle}</p>
            </div>
            <div className="flex items-center justify-between gap-2 text-sidebar-foreground">
                {localeSwitch}
                <form action={signOut}>
                    <button
                        type="submit"
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-sidebar-active hover:text-white"
                    >
                        <LogOut className="size-4" aria-hidden />
                        {signOutLabel}
                    </button>
                </form>
            </div>
        </div>
    );

    return (
        <div className="lg:grid lg:grid-cols-[260px_1fr]">
            <aside className="sticky top-[33px] hidden h-[calc(100dvh-33px)] flex-col bg-sidebar lg:flex">
                <div className="px-5 py-4 text-white">
                    <Link href="/dashboard">
                        <Brand inverted />
                    </Link>
                </div>
                {nav}
                {footer}
            </aside>
            <div className="sticky top-[33px] z-30 flex items-center justify-between border-b bg-sidebar px-4 py-3 text-white lg:hidden">
                <Link href="/dashboard">
                    <Brand inverted />
                </Link>
                <button
                    type="button"
                    onClick={() => setOpenFor(open ? null : pathname)}
                    aria-expanded={open}
                    aria-controls="mobile-nav"
                    className="rounded-md p-2 hover:bg-sidebar-active"
                >
                    {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
                    <span className="sr-only">{menuLabel}</span>
                </button>
            </div>
            {open && (
                <div id="mobile-nav" className="fixed inset-x-0 top-[90px] bottom-0 z-30 flex flex-col bg-sidebar lg:hidden">
                    {nav}
                    {footer}
                </div>
            )}
            <main id="main" className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
                <div className="mx-auto max-w-6xl">{children}</div>
            </main>
        </div>
    );
}
