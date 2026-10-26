import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { weekStart } from '../../src/shared/checkin/score';
import {
    backend,
    consent,
    coordinationApi,
    fakeSession,
    FILE_ID,
    fileConsent,
    ownFile,
    supportApi,
    supportRequest,
    USER_ID
} from './backend';
import { renderApp } from './render';

function member(extra: Array<Parameters<typeof consent>[0]> = []) {
    backend.session = fakeSession();
    backend.profile.display_name = 'Claire';
    backend.consents = [consent('privacy_policy'), ...extra.map((t) => consent(t))];
}

async function answer(user: ReturnType<typeof userEvent.setup>, values: [number, number, number]) {
    const groups = ['manqué d’énergie', 'ne plus arriver à tout faire', 'porter tout ça sans aide'];
    for (const [i, text] of groups.entries()) {
        const group = screen.getByRole('group', { name: new RegExp(text) });
        await user.click(within(group).getByRole('radio', { name: new RegExp(`^${values[i]} — `) }));
    }
}

describe('bilan de la semaine', () => {
    it('sans consentement : résultat sur le téléphone, rien de gardé ; semaine lourde → répit et intervenante', async () => {
        const user = userEvent.setup();
        member();
        renderApp('/bilan');
        expect(await screen.findByText(/Vos réponses ne sont pas gardées/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Voir mon bilan' }));
        expect(await screen.findByText('Répondez aux trois questions pour voir votre bilan.')).toBeInTheDocument();
        await answer(user, [4, 4, 4]);
        await user.click(screen.getByRole('button', { name: 'Voir mon bilan' }));
        expect(await screen.findByRole('heading', { name: 'Cette semaine semble lourde.' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Parler à une intervenante' })).toHaveAttribute(
            'href',
            '/parler-a-une-intervenante?origine=bilan'
        );
        // Ressources de répit tirées de la table des ressources.
        expect(screen.getByRole('heading', { name: 'Info-aidant (L’Appui)' })).toBeInTheDocument();
        expect(supportApi.saveCheckin).not.toHaveBeenCalled();
    });

    it('avec « Mon bilan de la semaine » : gardé pour la semaine, historique visible ; semaine légère', async () => {
        const user = userEvent.setup();
        member(['caregiver_checkin']);
        backend.support.checkins = [
            { id: 'e6000000-0000-4000-8000-000000000001', week_start: '2026-09-28', fatigue: 3, overwhelm: 2, isolation: 2 }
        ];
        renderApp('/bilan');
        expect(await screen.findByText(/gardées pour vous seulement/)).toBeInTheDocument();
        expect(screen.getByText('Fatigue 3 sur 5, débordement 2 sur 5, isolement 2 sur 5')).toBeInTheDocument();
        await answer(user, [1, 2, 1]);
        await user.click(screen.getByRole('button', { name: 'Voir mon bilan' }));
        expect(await screen.findByRole('heading', { name: 'Merci d’avoir pris ce moment pour vous.' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Parler à une intervenante' })).not.toBeInTheDocument();
        await waitFor(() =>
            expect(supportApi.saveCheckin).toHaveBeenCalledWith(weekStart(), { fatigue: 1, overwhelm: 2, isolation: 1 }, null)
        );
    });

    it('une seule réponse à 5 suffit pour proposer de l’aide', async () => {
        const user = userEvent.setup();
        member();
        renderApp('/bilan');
        await screen.findByRole('heading', { level: 1, name: 'Comment allez-vous cette semaine ?' });
        await answer(user, [1, 1, 5]);
        await user.click(screen.getByRole('button', { name: 'Voir mon bilan' }));
        expect(await screen.findByRole('heading', { name: 'Cette semaine semble lourde.' })).toBeInTheDocument();
    });
});

describe('parler à une intervenante', () => {
    it('rappel des urgences, téléphone exigé, origine « bilan », aucun délai promis', async () => {
        const user = userEvent.setup();
        member();
        renderApp('/parler-a-une-intervenante?origine=bilan');
        expect(await screen.findByRole('heading', { level: 1, name: 'Parler à une intervenante' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /911/ })).toHaveAttribute('href', 'tel:911');
        // Aucun délai promis (Q4) : « dès que possible », sans heure ni jour.
        expect(screen.getByText('Elle vous contactera dès que possible.')).toBeInTheDocument();
        const form = screen.getByRole('button', { name: 'Envoyer ma demande' }).closest('form') as HTMLElement;
        expect(form.textContent).not.toMatch(/\d+\s*(heures?|h|jours?|minutes?)\b/);
        expect(screen.getByText('Vos réponses au bilan ne sont pas transmises.')).toBeInTheDocument();
        expect(screen.getByLabelText('Votre prénom')).toHaveValue('Claire');
        await user.click(screen.getByRole('button', { name: 'Envoyer ma demande' }));
        expect(await screen.findByText('Entrez un numéro de téléphone d’au moins 7 chiffres.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Votre numéro de téléphone'), '514 555-0101');
        await user.type(screen.getByLabelText('Ce dont vous voulez parler (facultatif)'), 'Je suis épuisée.');
        await user.click(screen.getByRole('button', { name: 'Envoyer ma demande' }));
        await waitFor(() =>
            expect(supportApi.createSupportRequest).toHaveBeenCalledWith({
                origin: 'checkin',
                contact_name: 'Claire',
                preferred_contact: 'phone',
                phone: '514 555-0101',
                preferred_times: null,
                message: 'Je suis épuisée.',
                care_file_id: null
            })
        );
        expect(await screen.findByText(/Votre demande est envoyée/)).toBeInTheDocument();
    });

    it('mes demandes : état, et retrait par la personne', async () => {
        const user = userEvent.setup();
        member();
        const open = supportRequest({ status: 'assigned', assigned_worker_id: 'f0000000-0000-4000-8000-00000000000f' });
        backend.support.myRequests = [open, supportRequest({ status: 'closed', closed_at: '2026-10-29T10:00:00Z' })];
        renderApp('/parler-a-une-intervenante');
        expect(await screen.findByText('Prise en charge par une intervenante.')).toBeInTheDocument();
        expect(screen.getByText('Fermée.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /^Je n’en ai plus besoin/ }));
        await waitFor(() => expect(supportApi.cancelSupportRequest).toHaveBeenCalledWith(open.id));
    });

    it('écran d’urgence : demande de rappel sur place, sans perdre la saisie', async () => {
        const user = userEvent.setup();
        member(['health_information']);
        ownFile();
        backend.file.consents = [fileConsent()];
        renderApp(`/dossiers/${FILE_ID}/carnet`);
        const field = await screen.findByLabelText('Nouvelle note');
        await act(async () => {
            fireEvent.change(field, { target: { value: 'Je n’en peux plus, je veux mourir' } });
        });
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Demander qu’on me rappelle' }));
        expect(within(dialog).queryByLabelText('Ce dont vous voulez parler (facultatif)')).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole('radio', { name: /Par courriel/ }));
        await user.click(within(dialog).getByRole('button', { name: 'Envoyer ma demande' }));
        await waitFor(() =>
            expect(supportApi.createSupportRequest).toHaveBeenCalledWith(
                expect.objectContaining({ origin: 'distress_screen', preferred_contact: 'email', message: null, care_file_id: null })
            )
        );
        expect(await within(dialog).findByText(/Votre demande est envoyée/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Revenir à ma saisie' }));
        expect(screen.getByLabelText('Nouvelle note')).toHaveValue('Je n’en peux plus, je veux mourir');
        expect(coordinationApi.addJournalEntry).not.toHaveBeenCalled();
    });
});

describe('tableau des intervenantes', () => {
    function worker() {
        backend.session = fakeSession('aal2');
        backend.profile = { id: USER_ID, display_name: 'Nadia', app_role: 'relais_worker' };
        backend.consents = [consent('privacy_policy')];
    }

    it('réservé aux intervenantes', async () => {
        member();
        renderApp('/intervenante');
        expect(await screen.findByText('Cette section est réservée aux intervenantes de Relais.')).toBeInTheDocument();
        expect(supportApi.listSupportRequests).not.toHaveBeenCalled();
    });

    it('nouvelles demandes : l’écran d’urgence en premier ; prise en charge et note interne', async () => {
        const user = userEvent.setup();
        worker();
        const calm = supportRequest({ contact_name: 'Denis', created_at: '2026-10-29T10:00:00Z' });
        const urgent = supportRequest({ contact_name: 'Claire', origin: 'distress_screen', created_at: '2026-10-30T10:00:00Z' });
        backend.support.board = [calm, urgent];
        renderApp('/intervenante');
        const filters = await screen.findByRole('group', { name: 'Afficher' });
        expect(within(filters).getByRole('radio', { name: 'Nouvelles (2)' })).toBeChecked();
        const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/intervenante/demandes/'));
        expect(links.map((l) => l.textContent)).toEqual([expect.stringContaining('Claire'), expect.stringContaining('Denis')]);
        expect(links[0]).toHaveTextContent('Écran d’urgence');

        await user.click(links[0]!);
        expect(await screen.findByRole('heading', { level: 1, name: 'Claire' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /^Appeler Claire/ })).toHaveAttribute('href', 'tel:5145550101');
        await user.click(screen.getByRole('button', { name: 'Je m’en occupe' }));
        await waitFor(() => expect(supportApi.setSupportStatus).toHaveBeenCalledWith(urgent.id, 'assigned'));
        await user.type(screen.getByLabelText('Nouvelle note interne'), 'Je veux mourir, a-t-elle écrit : rappel fait.');
        await user.click(screen.getByRole('button', { name: 'Ajouter la note' }));
        await waitFor(() =>
            expect(supportApi.addSupportNote).toHaveBeenCalledWith(urgent.id, 'Je veux mourir, a-t-elle écrit : rappel fait.')
        );
        // Notes professionnelles : pas d'écran d'urgence pour l'intervenante.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});

describe('évaluation du pilote', () => {
    it('sans consentement : invitation à l’accepter', async () => {
        member();
        renderApp('/evaluation');
        expect(await screen.findByText(/acceptez « Évaluation du pilote »/)).toBeInTheDocument();
        expect(supportApi.listMyFeedback).not.toHaveBeenCalled();
    });

    it('deux questions : heures par demi-heure, satisfaction', async () => {
        const user = userEvent.setup();
        member(['pilot_evaluation']);
        renderApp('/evaluation');
        const hours = await screen.findByLabelText(/Combien d’heures Relais vous a-t-il fait gagner/);
        await user.type(hours, '2,3');
        await user.click(screen.getByRole('button', { name: 'Envoyer mes réponses' }));
        expect(await screen.findByText('Entrez un nombre d’heures entre 0 et 80, par demi-heure.')).toBeInTheDocument();
        await user.clear(hours);
        await user.type(hours, '1,5');
        await user.click(screen.getByRole('radio', { name: '4 — Bien' }));
        await user.click(screen.getByRole('button', { name: 'Envoyer mes réponses' }));
        await waitFor(() => expect(supportApi.saveFeedback).toHaveBeenCalledWith(weekStart(), { hours_saved: 1.5, satisfaction: 4 }, null));
        expect(await screen.findByText('Merci ! Vos réponses de la semaine sont enregistrées.')).toBeInTheDocument();
    });
});

describe('mesures du pilote (admin)', () => {
    function admin() {
        backend.session = fakeSession('aal2');
        backend.profile = { id: USER_ID, display_name: 'Ada', app_role: 'admin' };
        backend.consents = [consent('privacy_policy')];
    }
    const base = {
        generated_at: '2026-10-30T14:00:00Z',
        minimum_respondents: 3,
        participation: { care_files: 2, members: 3, pilot_consents: 2 },
        feedback_by_week: [],
        programs: { files: 1, identified: 8, requested: 2, obtained: 1, refused: 0, median_days_to_request: 4 },
        support: {
            total: 3,
            new: 1,
            assigned: 1,
            closed: 1,
            from_button: 1,
            from_distress_screen: 1,
            from_checkin: 1,
            median_hours_to_assignment: 2.5
        }
    };

    it('moins de 3 répondants : moyennes masquées', async () => {
        admin();
        backend.support.metrics = { ...base, feedback: { respondents: 2, suppressed: true } };
        renderApp('/admin/pilote');
        expect(await screen.findByText('Résultats masqués : 2 répondants, il en faut au moins 3.')).toBeInTheDocument();
        expect(screen.getByText('8 programmes repérés, 2 demandés, 1 obtenus, 0 refusés')).toBeInTheDocument();
        expect(screen.getByText('Délai médian de prise en charge : 2,5 h')).toBeInTheDocument();
        expect(screen.getByText(/Le bilan de la semaine des aidants n’apparaît jamais ici/)).toBeInTheDocument();
    });

    it('3 répondants ou plus : moyennes regroupées', async () => {
        admin();
        backend.support.metrics = {
            ...base,
            feedback: {
                respondents: 3,
                responses: 3,
                suppressed: false,
                hours_saved_avg: 2.2,
                satisfaction_avg: 4,
                satisfaction: { '1': 0, '2': 0, '3': 1, '4': 1, '5': 1 }
            }
        };
        renderApp('/admin/pilote');
        expect(await screen.findByText('Temps gagné : 2,2 h par semaine en moyenne')).toBeInTheDocument();
        expect(screen.getByText('5 — Tout à fait : 1')).toBeInTheDocument();
    });

    it('réservé à l’admin', async () => {
        member();
        renderApp('/admin/pilote');
        expect(await screen.findByText('Cette section est réservée à l’administration de Relais.')).toBeInTheDocument();
        expect(supportApi.getPilotMetrics).not.toHaveBeenCalled();
    });
});
