import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { buttonClass, Notice, PageTitle, requestPageTitleFocus } from '../components/ui';
import { fr } from '../i18n/fr';
import { useSession } from './session';

/** Après chaque navigation : focus sur le titre de page (lecteurs d'écran). Le titre d'onglet est fixé par PageTitle. */
function RouteFocus() {
    const { pathname } = useLocation();
    useEffect(() => {
        const frame = window.requestAnimationFrame(requestPageTitleFocus);
        return () => window.cancelAnimationFrame(frame);
    }, [pathname]);
    return null;
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `inline-flex min-h-12 items-center rounded-lg px-2 font-bold ${isActive ? 'bg-brand-soft text-brand-strong underline underline-offset-4' : 'text-brand'}`;

export function AppLayout() {
    const { session } = useSession();
    const location = useLocation();
    const notice = (location.state as { notice?: string } | null)?.notice;

    return (
        <div className="flex min-h-dvh flex-col">
            <a
                href="#contenu"
                className="sr-only rounded-lg bg-surface p-3 font-bold focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
            >
                {fr.app.skipLink}
            </a>
            <RouteFocus />
            <header className="no-print border-b border-line bg-surface">
                <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-2">
                    <Link
                        to={session ? '/accueil' : '/'}
                        className="inline-flex min-h-12 items-center gap-2 text-2xl font-bold text-brand-strong"
                    >
                        <img src="/favicon.svg" alt="" width={28} height={28} />
                        {fr.app.name}
                    </Link>
                    <Link to="/aide" className={buttonClass('danger', 'shrink-0 px-3 whitespace-nowrap')}>
                        {fr.nav.help}
                    </Link>
                </div>
                {session && (
                    <nav aria-label={fr.nav.label} className="mx-auto max-w-2xl px-2 pb-1">
                        <ul className="flex flex-wrap gap-x-1">
                            <li>
                                <NavLink to="/accueil" className={navLinkClass}>
                                    {fr.nav.home}
                                </NavLink>
                            </li>
                            <li>
                                <NavLink to="/mes-consentements" className={navLinkClass}>
                                    {fr.nav.consents}
                                </NavLink>
                            </li>
                            <li>
                                <NavLink to="/compte" className={navLinkClass}>
                                    {fr.nav.account}
                                </NavLink>
                            </li>
                        </ul>
                    </nav>
                )}
            </header>
            <main id="contenu" className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
                {notice && (
                    <div className="mb-4">
                        <Notice tone="success">{notice}</Notice>
                    </div>
                )}
                <Outlet />
            </main>
            <footer className="no-print border-t border-line bg-surface">
                <div className="mx-auto flex max-w-2xl flex-col gap-1 px-4 py-4 text-muted">
                    <p>{fr.footer.notEmergency}</p>
                    <p>{fr.footer.notMedical}</p>
                    <Link to="/confidentialite" className="inline-flex min-h-12 items-center text-brand underline">
                        {fr.footer.privacy}
                    </Link>
                </div>
            </footer>
        </div>
    );
}

export function NotFoundPage() {
    return (
        <div className="flex flex-col gap-4">
            <PageTitle>{fr.notFound.title}</PageTitle>
            <p>{fr.notFound.text}</p>
            <Link to="/" className={buttonClass('secondary')}>
                {fr.notFound.back}
            </Link>
        </div>
    );
}
