import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import { buttonClass, Loading, Notice } from '../../components/ui';
import { benefits as tbf } from '../../i18n/benefits.fr';
import { coordination as tc } from '../../i18n/coordination.fr';
import { documents as td } from '../../i18n/documents.fr';
import { files as tf } from '../../i18n/files.fr';
import { logFileOpened, type CareFile } from '../../lib/careFiles';
import { useCareFile, useFileAccess } from './useFile';

export interface FileContext {
    file: CareFile;
    access: ReturnType<typeof useFileAccess>;
}

export function useFileContext(): FileContext {
    return useOutletContext<FileContext>();
}

/** Sections réservées à la personne aidante principale (la base refuserait de toute façon). */
export function OwnerOnly({ children }: { children: ReactNode }) {
    const { access } = useFileContext();
    if (access.membership?.access_level !== 'owner') return <Notice tone="info">{tf.ownerOnly}</Notice>;
    return <>{children}</>;
}

const tabClass = ({ isActive }: { isActive: boolean }) =>
    `inline-flex min-h-12 items-center rounded-lg px-3 font-bold ${isActive ? 'bg-brand text-white' : 'bg-surface text-brand'}`;

/** Cadre commun des pages d'un dossier : onglets selon les droits, rappel du consentement manquant. */
export function FileLayout() {
    const { fileId = '' } = useParams();
    const { pathname } = useLocation();
    const file = useCareFile(fileId);
    const access = useFileAccess(fileId);
    const logged = useRef<string | null>(null);

    // Journal des accès : une entrée par ouverture du dossier.
    const ready = Boolean(file.data && access.membership);
    useEffect(() => {
        if (!ready || logged.current === fileId) return;
        logged.current = fileId;
        void logFileOpened(fileId).catch(() => undefined);
    }, [ready, fileId]);

    if (file.isPending || access.isPending) return <Loading />;
    if (file.isError || access.isError || !file.data || !access.membership) {
        return (
            <div className="flex flex-col gap-4">
                <Notice tone="error">{tf.notFound}</Notice>
                <Link to="/accueil" className={buttonClass('secondary')}>
                    {tf.myFiles}
                </Link>
            </div>
        );
    }

    const isOwner = access.membership.access_level === 'owner';
    const health = access.canRead('health');
    // Deux groupes : le quotidien d'abord, puis la gestion du dossier.
    const daily = [
        { to: '', label: tf.tabs.overview, end: true },
        { to: 'agenda', label: tc.agendaTab },
        { to: 'taches', label: tc.tasksTab },
        ...(health ? [{ to: 'carnet', label: tc.journalTab }] : []),
        ...(health
            ? [
                  { to: 'documents', label: td.tab },
                  { to: 'chronologie', label: td.timelineTab }
              ]
            : []),
        ...(access.canRead('benefits') ? [{ to: 'droits', label: tbf.tab }] : [])
    ];
    const manage = [
        { to: 'profil', label: tf.tabs.profile },
        { to: 'contacts', label: tf.tabs.contacts },
        { to: 'consentement', label: tf.tabs.consent },
        { to: 'membres', label: tf.tabs.members },
        ...(isOwner
            ? [
                  { to: 'journal', label: tf.tabs.log },
                  { to: 'parametres', label: tf.tabs.settings }
              ]
            : [])
    ];
    const onConsentPage = pathname.endsWith('/consentement');
    const group = (id: string, title: string, tabs: Array<{ to: string; label: string; end?: boolean }>) => (
        <div className="flex flex-col gap-1">
            <p id={id} className="text-sm font-bold tracking-wide text-muted uppercase">
                {title}
            </p>
            <ul aria-labelledby={id} className="flex flex-wrap gap-2">
                {tabs.map((tab) => (
                    <li key={tab.to}>
                        <NavLink to={tab.to} end={tab.end} className={tabClass}>
                            {tab.label}
                        </NavLink>
                    </li>
                ))}
            </ul>
        </div>
    );

    return (
        <div className="flex flex-col gap-4">
            <p className="no-print font-bold text-muted">{file.data.title}</p>
            <nav aria-label={tf.nav} className="no-print flex flex-col gap-3">
                {group('file-nav-daily', tc.navDaily, daily)}
                {group('file-nav-file', tc.navFile, manage)}
            </nav>
            {!access.recipientConsent && !onConsentPage && (
                <Notice tone="info">
                    <p>{isOwner ? tf.consentMissingOwner : tf.consentMissingMember}</p>
                    {isOwner && (
                        <Link to="consentement" className={buttonClass('primary', 'mt-3')}>
                            {tf.recordConsent}
                        </Link>
                    )}
                </Notice>
            )}
            <Outlet context={{ file: file.data, access } satisfies FileContext} />
        </div>
    );
}
