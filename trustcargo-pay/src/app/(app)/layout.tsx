import { logout } from '@/app/actions/auth';
import { AppShell, type NavSection } from '@/components/app/app-shell';
import { LocaleSwitch } from '@/components/app/locale-switch';
import type { PlatformRole } from '@/domain/model';
import { getI18n } from '@/i18n/server';
import { heldPlatformRoles } from '@/server/auth/actor';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
    const actor = await requireActor();
    const { t, locale } = await getI18n();
    const app = await getApp();
    const user = (await app.deps.uow.run((db) => db.users.get(actor.userId)))!;
    const unread = (await app.notifications.list(actor)).filter((n) => !n.readAt).length;
    // Navigation follows every role the account holds: a back-office link of a role still waiting for its MFA
    // challenge leads to that challenge (requireStaff), never to the data.
    const held = heldPlatformRoles(actor);
    const staff = held.length > 0;
    const can = (...roles: PlatformRole[]) => roles.some((r) => held.includes(r));

    const sections: NavSection[] = [];
    if (!staff) {
        sections.push({
            items: [
                { href: '/dashboard', label: t('nav.dashboard'), icon: 'dashboard' },
                { href: '/transactions', label: t('nav.transactions'), icon: 'transactions' },
                { href: '/transactions/new', label: t('nav.newTransaction'), icon: 'new' },
                { href: '/verification', label: t('nav.verification'), icon: 'verification' }
            ]
        });
    } else {
        const items: NavSection['items'] = [{ href: '/admin', label: t('nav.overview'), icon: 'overview' }];
        if (can('compliance_analyst', 'dispute_manager', 'finance_operator', 'auditor', 'document_reviewer'))
            items.push({ href: '/admin/transactions', label: t('nav.transactions'), icon: 'transactions' });
        if (can('compliance_analyst', 'auditor'))
            items.push(
                { href: '/admin/verifications', label: t('nav.verifications'), icon: 'verifications' },
                { href: '/admin/organizations', label: t('nav.organizations'), icon: 'organizations' },
                { href: '/admin/risk', label: t('nav.riskAlerts'), icon: 'risk' }
            );
        if (can('document_reviewer', 'compliance_analyst'))
            items.push({ href: '/admin/documents', label: t('nav.documents'), icon: 'documents' });
        if (can('dispute_manager', 'auditor', 'compliance_analyst'))
            items.push({ href: '/admin/disputes', label: t('nav.disputes'), icon: 'disputes' });
        if (can('finance_operator', 'platform_admin', 'auditor'))
            items.push({ href: '/admin/partners', label: t('nav.partners'), icon: 'partners' });
        if (can('finance_operator', 'auditor')) items.push({ href: '/admin/ledger', label: t('nav.ledger'), icon: 'ledger' });
        if (can('auditor', 'compliance_analyst')) items.push({ href: '/admin/audit', label: t('nav.audit'), icon: 'audit' });
        if (can('platform_admin', 'auditor', 'compliance_analyst'))
            items.push({ href: '/admin/corridors', label: t('nav.corridors'), icon: 'corridors' });
        if (can('platform_admin', 'auditor')) items.push({ href: '/admin/security', label: t('nav.security'), icon: 'security' });
        sections.push({ title: t('nav.backOffice'), items });
    }
    sections.push({
        items: [
            { href: '/notifications', label: t('nav.notifications'), icon: 'notifications', badge: unread || undefined },
            { href: '/settings', label: t('nav.settings'), icon: 'settings' }
        ]
    });

    return (
        <AppShell
            sections={sections}
            user={{ name: user.fullName, subtitle: staff ? held.join(' · ') : user.email }}
            signOut={logout}
            signOutLabel={t('nav.signOut')}
            menuLabel={t('nav.menu')}
            localeSwitch={
                <LocaleSwitch
                    locale={locale}
                    label={t('nav.language')}
                    back="/dashboard"
                    className="hover:bg-sidebar-active hover:text-white"
                />
            }
        >
            {children}
        </AppShell>
    );
}
