import { Navigate, Outlet, useLocation } from 'react-router';
import { Button, Loading, Notice } from '../components/ui';
import { fr } from '../i18n/fr';
import { hasCurrentPrivacyConsent } from '../lib/consents';
import { useMyConsents, useProfile } from './queries';
import { sessionAal, useSession } from './session';

function LoadError({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="flex flex-col gap-4 py-6">
            <Notice tone="error">{fr.app.genericError}</Notice>
            <Button variant="secondary" onClick={onRetry}>
                {fr.app.retry}
            </Button>
        </div>
    );
}

/** Pages réservées aux personnes connectées. */
export function RequireSession() {
    const { session, loading } = useSession();
    const location = useLocation();
    if (loading) return <Loading />;
    if (!session) return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
    return <Outlet />;
}

/** Intervenantes et admins : vérification en deux étapes obligatoire avant toute page. */
export function RequireStaffMfa() {
    const { session } = useSession();
    const profile = useProfile();
    const location = useLocation();
    if (profile.isPending) return <Loading />;
    if (profile.isError) return <LoadError onRetry={() => void profile.refetch()} />;
    if (profile.data.app_role !== 'member' && sessionAal(session) !== 'aal2') {
        return <Navigate to="/verification" replace state={{ from: location.pathname }} />;
    }
    return <Outlet />;
}

/** Politique de confidentialité acceptée (version en vigueur) et nom choisi, sinon accueil des nouveaux. */
export function RequireOnboarding() {
    const profile = useProfile();
    const consents = useMyConsents();
    if (profile.isPending || consents.isPending) return <Loading />;
    if (profile.isError) return <LoadError onRetry={() => void profile.refetch()} />;
    if (consents.isError) return <LoadError onRetry={() => void consents.refetch()} />;
    if (!hasCurrentPrivacyConsent(consents.data) || !profile.data.display_name) {
        return <Navigate to="/bienvenue" replace />;
    }
    return <Outlet />;
}
