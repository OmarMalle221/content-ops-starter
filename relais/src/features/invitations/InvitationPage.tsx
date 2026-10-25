import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useMyConsents, useProfile } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, buttonClass, Loading, Notice, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { files as tf } from '../../i18n/files.fr';
import { ApiError } from '../../lib/api';
import { acceptInvitation } from '../../lib/careFiles';
import { hasCurrentPrivacyConsent } from '../../lib/consents';
import { fileKeys } from '../files/useFile';

const STORAGE_KEY = 'relais-invitation';

/** Jeton d'invitation en attente (le temps de se connecter et d'accepter la politique). */
export function pendingInvitationToken(): string | null {
    try {
        return window.sessionStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

function storeToken(token: string | null): void {
    try {
        if (token) window.sessionStorage.setItem(STORAGE_KEY, token);
        else window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // Stockage indisponible (navigation privée) : le jeton reste seulement dans l'adresse.
    }
}

/**
 * Le lien d'invitation porte le jeton dans le fragment (#) : il n'est jamais transmis aux serveurs web.
 * Il est gardé le temps de la connexion, puis effacé une fois l'invitation acceptée.
 */
export function InvitationPage() {
    const { session, loading } = useSession();
    const location = useLocation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const profile = useProfile();
    const consents = useMyConsents();
    const [token] = useState(() => {
        const fromHash = location.hash.replace(/^#/, '');
        return /^[0-9a-f]{64}$/.test(fromHash) ? fromHash : pendingInvitationToken();
    });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (token) storeToken(token);
        // Retirer le jeton de l'adresse affichée.
        if (location.hash) window.history.replaceState(null, '', location.pathname);
    }, [token, location.hash, location.pathname]);

    if (!token) {
        return (
            <div className="flex flex-col gap-4">
                <PageTitle>{tf.invitationTitle}</PageTitle>
                <Notice tone="error">{tf.invitationMissing}</Notice>
            </div>
        );
    }
    if (loading) return <Loading />;
    if (!session) {
        return (
            <div className="flex flex-col gap-4">
                <PageTitle>{tf.invitationTitle}</PageTitle>
                <p>{tf.invitationSignIn}</p>
                <Link to="/connexion" state={{ from: '/invitation' }} className={buttonClass('primary')}>
                    {tf.signInToAccept}
                </Link>
            </div>
        );
    }
    if (profile.isPending || consents.isPending) return <Loading />;
    if (profile.data && consents.data && (!hasCurrentPrivacyConsent(consents.data) || !profile.data.display_name)) {
        // D'abord l'accueil des nouveaux ; l'accueil ramène ensuite ici (jeton gardé).
        return <Navigate to="/bienvenue" replace />;
    }

    async function accept() {
        if (!token) return;
        setBusy(true);
        setError(null);
        try {
            const fileId = await acceptInvitation(token);
            storeToken(null);
            await queryClient.invalidateQueries({ queryKey: fileKeys.myFiles(session?.user.id) });
            navigate(`/dossiers/${fileId}`, { replace: true });
        } catch (e) {
            const code = e instanceof ApiError ? e.code : undefined;
            if (code !== '23505') storeToken(null);
            setError(
                code === '42501'
                    ? tf.invitationWrongEmail
                    : code === '22023'
                      ? tf.invitationInvalid
                      : code === '23505'
                        ? tf.invitationAlreadyMember
                        : fr.app.genericError
            );
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <PageTitle>{tf.invitationTitle}</PageTitle>
            <p>{tf.invitationIntro}</p>
            {error && <Notice tone="error">{error}</Notice>}
            <Button onClick={() => void accept()} disabled={busy}>
                {tf.invitationAccept}
            </Button>
        </div>
    );
}
