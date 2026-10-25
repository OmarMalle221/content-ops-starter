'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Menu, Plus, ShieldAlert, X } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@dfn/ui';
import { api } from '@/lib/api-client';
import { initials } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { Logo } from '@/components/logo';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SidebarNav } from './sidebar-nav';

export interface ShellUser {
  firstName: string;
  lastName: string;
  email: string;
  /** Effective role from /v1/auth/me ('USER' while a staff account still needs MFA). */
  globalRole: string;
  /** REQUIRE_STAFF_MFA: staff role on record, staff tools off until MFA is enabled. */
  staffMfaRequired?: boolean;
}

export function AppShell({
  user,
  unread,
  children,
}: {
  user: ShellUser;
  unread: number;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const staff = user.globalRole !== 'USER';

  async function logout() {
    await api('/v1/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="flex min-h-[calc(100vh-2rem)]">
      <aside className="hidden w-64 shrink-0 border-r bg-card/50 lg:flex lg:flex-col">
        <div className="flex h-16 items-center px-5">
          <Logo href="/dashboard" />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <SidebarNav staff={staff} unread={unread} />
        </div>
        <div className="border-t p-4 text-xs text-muted-foreground">{t('app.sandbox')}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Menu"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X /> : <Menu />}
          </Button>
          <div className="lg:hidden">
            <Logo href="/dashboard" compact />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link href="/transactions/new">
                <Plus /> {t('nav.newTransaction')}
              </Link>
            </Button>
            <LocaleSwitcher />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
                  aria-label="Account"
                >
                  {initials(user.firstName, user.lastName)}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="truncate text-sm font-medium text-foreground">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="truncate text-xs font-normal">{user.email}</p>
                  {staff ? (
                    <Badge variant="secondary" className="mt-1">
                      {user.globalRole}
                    </Badge>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">{t('nav.settings')}</Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={logout}>
                  <LogOut className="size-4" /> {t('nav.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {open ? (
          <div className="border-b bg-card p-3 lg:hidden">
            <SidebarNav staff={staff} unread={unread} onNavigate={() => setOpen(false)} />
          </div>
        ) : null}
        <main className="flex-1 px-4 py-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-6xl animate-fade-in">
            {user.staffMfaRequired ? (
              <Alert variant="warning" className="mb-6">
                <ShieldAlert className="size-4" />
                <AlertTitle>{t('passkeys.staffMfa.title')}</AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>{t('passkeys.staffMfa.body')}</p>
                  {pathname === '/settings' ? (
                    <p className="font-medium">{t('passkeys.staffMfa.onSettings')}</p>
                  ) : (
                    <Button asChild size="sm">
                      <Link href="/settings">{t('passkeys.staffMfa.action')}</Link>
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            ) : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
