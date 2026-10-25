import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import consentTexts from '../../src/content/consent-texts.fr.json';
import { api, auth, backend, consent, fakeSession } from './backend';
import { renderApp } from './render';

const VERSION = consentTexts.privacy_policy.version;

describe('accès aux pages', () => {
    it('envoie vers la connexion sans session', async () => {
        const { router } = renderApp('/accueil');
        await waitFor(() => expect(router.state.location.pathname).toBe('/connexion'));
        expect(await screen.findByRole('heading', { level: 1, name: 'Se connecter' })).toBeInTheDocument();
    });

    it('envoie vers l’accueil des nouveaux sans politique de confidentialité acceptée', async () => {
        backend.session = fakeSession();
        const { router } = renderApp('/accueil');
        await waitFor(() => expect(router.state.location.pathname).toBe('/bienvenue'));
    });

    it('redemande la politique quand sa version a changé', async () => {
        backend.session = fakeSession();
        backend.profile.display_name = 'Louise';
        backend.consents = [consent('privacy_policy', '2025-01-01')];
        const { router } = renderApp('/accueil');
        await waitFor(() => expect(router.state.location.pathname).toBe('/bienvenue'));
        expect(await screen.findByText(/La politique de confidentialité a changé/)).toBeInTheDocument();
        // Seule la politique est proposée de nouveau ; les autres textes n'ont pas changé de version.
        expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    });

    it('envoie une intervenante vers la vérification en deux étapes', async () => {
        backend.session = fakeSession('aal1');
        backend.profile = { ...backend.profile, display_name: 'Nadia', app_role: 'relais_worker' };
        backend.consents = [consent('privacy_policy', VERSION)];
        const { router } = renderApp('/accueil');
        await waitFor(() => expect(router.state.location.pathname).toBe('/verification'));
        expect(await screen.findByRole('img', { name: /Code QR/ })).toBeInTheDocument();
        expect(auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'stale-factor' });
    });

    it('laisse passer une intervenante vérifiée (aal2)', async () => {
        backend.session = fakeSession('aal2');
        backend.profile = { ...backend.profile, display_name: 'Nadia', app_role: 'relais_worker' };
        backend.consents = [consent('privacy_policy', VERSION)];
        renderApp('/accueil');
        expect(await screen.findByRole('heading', { level: 1, name: 'Bonjour Nadia' })).toBeInTheDocument();
    });

    it('la page d’aide immédiate est accessible sans session', async () => {
        renderApp('/aide');
        expect(await screen.findByRole('heading', { level: 1, name: 'Aide immédiate' })).toBeInTheDocument();
        expect(screen.getAllByRole('link', { name: 'Appeler le 911' })[0]).toHaveAttribute('href', 'tel:911');
    });
});

describe('accueil des nouveaux', () => {
    it('propose 4 consentements distincts, aucun pré-coché', async () => {
        backend.session = fakeSession();
        renderApp('/bienvenue');
        const boxes = await screen.findAllByRole('checkbox');
        expect(boxes).toHaveLength(4);
        for (const box of boxes) expect(box).not.toBeChecked();
        expect(screen.getByText('Obligatoire')).toBeInTheDocument();
        expect(screen.getAllByText('Facultatif')).toHaveLength(3);
    });

    it('refuse de continuer sans la politique de confidentialité', async () => {
        const user = userEvent.setup();
        backend.session = fakeSession();
        renderApp('/bienvenue');
        await user.click(await screen.findByLabelText(/J’accepte : Rappels par courriel/));
        await user.click(screen.getByRole('button', { name: 'Enregistrer mes choix' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('vous devez accepter la politique de confidentialité');
        expect(api.grantConsent).not.toHaveBeenCalled();
    });

    it('enregistre seulement les consentements cochés, puis demande le prénom', async () => {
        const user = userEvent.setup();
        backend.session = fakeSession();
        const { router } = renderApp('/bienvenue');
        await user.click(await screen.findByLabelText(/J’accepte : Comment Relais protège vos renseignements/));
        await user.click(screen.getByLabelText(/J’accepte : Rappels par courriel/));
        await user.click(screen.getByRole('button', { name: 'Enregistrer mes choix' }));

        await screen.findByRole('heading', { level: 1, name: 'Comment voulez-vous qu’on vous appelle ?' });
        expect(api.grantConsent).toHaveBeenCalledTimes(2);
        expect(api.grantConsent).toHaveBeenCalledWith('privacy_policy', VERSION);
        expect(api.grantConsent).toHaveBeenCalledWith('email_reminders', consentTexts.email_reminders.version);

        await pageReady('Comment voulez-vous qu’on vous appelle ?');
        await user.type(screen.getByLabelText('Votre prénom'), '  Louise ');
        await user.click(screen.getByRole('button', { name: 'Continuer' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/accueil'));
        expect(api.updateDisplayName).toHaveBeenCalledWith(backend.profile.id, 'Louise');
        expect(await screen.findByRole('heading', { level: 1, name: 'Bonjour Louise' })).toBeInTheDocument();
    });
});

describe('mes consentements', () => {
    function signedIn() {
        backend.session = fakeSession();
        backend.profile.display_name = 'Louise';
        backend.consents = [consent('privacy_policy', VERSION), consent('health_information', VERSION)];
    }

    it('affiche l’état de chaque consentement', async () => {
        signedIn();
        renderApp('/mes-consentements');
        const health = (await screen.findByRole('heading', { name: 'Renseignements de santé' })).closest('section') as HTMLElement;
        expect(within(health).getByText(/Accordé le 26 octobre 2026/)).toBeInTheDocument();
        const email = screen.getByRole('heading', { name: 'Rappels par courriel' }).closest('section') as HTMLElement;
        expect(within(email).getByText('Non accordé')).toBeInTheDocument();
        const privacy = screen
            .getByRole('heading', { name: 'Comment Relais protège vos renseignements' })
            .closest('section') as HTMLElement;
        expect(within(privacy).getByText(/supprimez votre compte/)).toBeInTheDocument();
        expect(within(privacy).queryByRole('button', { name: 'Retirer ce consentement' })).toBeNull();
    });

    it('demande une confirmation avant de retirer, puis retire', async () => {
        const user = userEvent.setup();
        signedIn();
        renderApp('/mes-consentements');
        const health = (await screen.findByRole('heading', { name: 'Renseignements de santé' })).closest('section') as HTMLElement;
        await user.click(within(health).getByRole('button', { name: 'Retirer ce consentement' }));
        const confirmation = within(health).getByRole('group', { name: 'Retirer le consentement « Renseignements de santé » ?' });
        expect(within(confirmation).getByText(/Vous ne pourrez plus ajouter de renseignements de santé/)).toBeInTheDocument();
        expect(api.revokeConsent).not.toHaveBeenCalled();
        await user.click(within(health).getByRole('button', { name: 'Confirmer le retrait' }));
        expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Consentement retiré.');
        expect(api.revokeConsent).toHaveBeenCalledWith(expect.any(String), 'health_information');
        expect(await within(health).findByText(/Retiré le 26 octobre 2026/)).toBeInTheDocument();
    });

    it('permet d’accorder un consentement facultatif', async () => {
        const user = userEvent.setup();
        signedIn();
        renderApp('/mes-consentements');
        const email = (await screen.findByRole('heading', { name: 'Rappels par courriel' })).closest('section') as HTMLElement;
        await user.click(within(email).getByRole('button', { name: 'Accorder ce consentement' }));
        expect(api.grantConsent).toHaveBeenCalledWith('email_reminders', consentTexts.email_reminders.version);
        expect(await within(email).findByText(/Accordé le/)).toBeInTheDocument();
    });
});

/** Attend que le titre de page ait reçu le focus (RouteFocus), pour taper ensuite sans être interrompu. */
async function pageReady(title: string) {
    const heading = await screen.findByRole('heading', { level: 1, name: title });
    await waitFor(() => expect(heading).toHaveFocus());
}

describe('connexion par code', () => {
    it('donne le focus au titre de la page', async () => {
        renderApp('/connexion');
        await pageReady('Se connecter');
        expect(document.title).toBe('Se connecter — Relais');
    });

    it('demande un code puis le vérifie', async () => {
        const user = userEvent.setup();
        renderApp('/connexion');
        await pageReady('Se connecter');
        await user.type(screen.getByLabelText('Votre adresse courriel'), 'Aidante@Example.test');
        await user.click(screen.getByRole('button', { name: 'Recevoir un code' }));
        expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: 'aidante@example.test', options: { shouldCreateUser: true } });
        expect(await screen.findByText(/Nous avons envoyé un code à aidante@example.test/)).toBeInTheDocument();

        await user.type(screen.getByLabelText('Code à 6 chiffres'), '12345');
        await user.click(screen.getByRole('button', { name: 'Me connecter' }));
        expect(await screen.findByText('Le code compte 6 chiffres.')).toBeInTheDocument();
        expect(auth.verifyOtp).not.toHaveBeenCalled();

        await user.type(screen.getByLabelText(/Code à 6 chiffres/), '6');
        await user.click(screen.getByRole('button', { name: 'Me connecter' }));
        expect(auth.verifyOtp).toHaveBeenCalledWith({ email: 'aidante@example.test', token: '123456', type: 'email' });
    });

    it('refuse une adresse incomplète sans appeler le serveur', async () => {
        const user = userEvent.setup();
        renderApp('/connexion');
        await pageReady('Se connecter');
        await user.type(screen.getByLabelText('Votre adresse courriel'), 'aidante@');
        await user.click(screen.getByRole('button', { name: 'Recevoir un code' }));
        expect(await screen.findByText(/Entrez une adresse courriel complète/)).toBeInTheDocument();
        expect(screen.getByLabelText(/Votre adresse courriel/)).toHaveAttribute('aria-invalid', 'true');
        expect(auth.signInWithOtp).not.toHaveBeenCalled();
    });
});
