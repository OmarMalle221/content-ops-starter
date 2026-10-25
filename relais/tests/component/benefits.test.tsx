import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api';
import { FAMILY_A, FAMILY_B } from '../support/families';
import { backend, benefitsApi, careFilesApi, consent, fakeSession, FILE_ID, fileConsent, ownFile, USER_ID } from './backend';
import { renderApp } from './render';

const BENEFITS = `/dossiers/${FILE_ID}/droits`;

function owner() {
    backend.session = fakeSession();
    backend.profile.display_name = 'Claire';
    backend.consents = [consent('privacy_policy'), consent('health_information')];
    ownFile();
    backend.file.consents = [fileConsent()];
}

function readOnlyMember() {
    backend.session = fakeSession();
    backend.profile.display_name = 'Gilles';
    backend.consents = [consent('privacy_policy')];
    backend.file.members = [
        {
            care_file_id: FILE_ID,
            user_id: 'c0000000-0000-4000-8000-00000000000c',
            role: 'primary_caregiver',
            access_level: 'owner',
            joined_at: ''
        },
        { care_file_id: FILE_ID, user_id: USER_ID, role: 'family_member', access_level: 'read_only', joined_at: '' }
    ];
    backend.file.consents = [fileConsent()];
}

describe('navigateur de droits', () => {
    it('questionnaire prérempli par le profil, puis liste personnalisée enregistrée', async () => {
        const user = userEvent.setup();
        owner();
        careFilesApi.getCareRecipient.mockResolvedValueOnce({
            care_file_id: FILE_ID,
            first_name: 'Louise',
            last_name: 'Tremblay',
            birth_year: new Date().getFullYear() - 82,
            living_setting: 'home',
            living_setting_since: null,
            residence_name: null,
            chsld_waitlist: false,
            chsld_waitlist_since: null
        } as never);
        renderApp(BENEFITS);
        expect(await screen.findByLabelText('Âge de votre proche')).toHaveValue('82');
        expect(screen.getByRole('radio', { name: 'À domicile' })).toBeChecked();
        const pays = screen.getByRole('group', { name: /paie-t-il des services/ });
        await user.click(within(pays).getByRole('radio', { name: 'Oui' }));
        await user.click(screen.getByRole('button', { name: 'Voir les aides possibles' }));
        await waitFor(() => expect(benefitsApi.saveAssessment).toHaveBeenCalled());
        const [fileId, answers, results] = benefitsApi.saveAssessment.mock.calls[0] as unknown as [
            string,
            unknown,
            Array<{ assessment: { level: string } }>
        ];
        expect(fileId).toBe(FILE_ID);
        expect(answers).toMatchObject({ recipient_age: 82, living_setting: 'home', pays_home_support_services: 'yes' });
        expect(results).toHaveLength(8);
    });

    it('chaque carte affiche la source, l’état de vérification et l’admissibilité à confirmer', async () => {
        owner();
        backend.file.answers = { answers: FAMILY_B, created_at: '2026-10-29T14:00:00Z' };
        renderApp(BENEFITS);
        expect(await screen.findByRole('heading', { name: 'Vous pourriez y avoir droit' })).toBeInTheDocument();
        const cards = screen.getAllByRole('article', { hidden: true });
        expect(cards).toHaveLength(8);
        for (const card of cards) {
            expect(within(card).getByText(/^Source : /)).toBeInTheDocument();
            expect(within(card).getByText(/Fiche À VÉRIFIER/)).toBeInTheDocument();
            expect(within(card).getByText(/^Admissibilité à confirmer auprès de/)).toBeInTheDocument();
        }
        // Famille B : PEFSAD et adaptation du domicile sont peu probables (repliés).
        expect(screen.getByText('Voir les 2 programmes peu probables')).toBeInTheDocument();
        // Aucun montant affiché nulle part.
        expect(document.body.textContent).not.toMatch(/\$|%/);
    });

    it('lecture seule : résultats visibles, pas de questionnaire', async () => {
        readOnlyMember();
        backend.file.answers = { answers: FAMILY_A, created_at: '2026-10-29T14:00:00Z' };
        renderApp(BENEFITS);
        expect(await screen.findByText('Vous pouvez consulter les résultats sans les modifier.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Refaire le questionnaire' })).not.toBeInTheDocument();
    });
});

describe('fiche d’un programme', () => {
    const program = () => backend.programs.find((p) => p.slug === 'credit-impot-personnes-handicapees')!;

    function withProgramInFile() {
        owner();
        backend.file.answers = { answers: FAMILY_B, created_at: '2026-10-29T14:00:00Z' };
        backend.file.programs = [
            {
                id: 'cf000000-0000-4000-8000-000000000001',
                care_file_id: FILE_ID,
                program_id: program().id,
                match_level: 'likely',
                status: 'to_explore',
                notes: null,
                letter_draft: null,
                identified_at: '2026-10-29T14:00:00Z',
                requested_at: null,
                decided_at: null,
                checklist: [
                    {
                        id: 'ci000000-0000-4000-8000-000000000001',
                        care_file_program_id: 'cf000000-0000-4000-8000-000000000001',
                        label: 'Formulaire T2201',
                        origin: 'program',
                        is_done: false,
                        done_at: null,
                        position: 0
                    }
                ]
            }
        ];
    }

    it('statut et pièces à fournir ; « je ne sais pas » quand l’explication n’est pas fiable', async () => {
        const user = userEvent.setup();
        withProgramInFile();
        renderApp(`${BENEFITS}/credit-impot-personnes-handicapees`);
        expect(
            await screen.findByRole('heading', { level: 1, name: 'Crédit d’impôt pour personnes handicapées (CIPH)' })
        ).toBeInTheDocument();
        await user.click(screen.getByRole('radio', { name: 'Demande en cours' }));
        await waitFor(() =>
            expect(benefitsApi.updateFileProgram).toHaveBeenCalledWith('cf000000-0000-4000-8000-000000000001', { status: 'in_progress' })
        );
        await user.click(screen.getByRole('checkbox', { name: 'Formulaire T2201' }));
        await waitFor(() => expect(benefitsApi.setChecklistItemDone).toHaveBeenCalledWith('ci000000-0000-4000-8000-000000000001', true));
        await user.click(screen.getByRole('button', { name: 'Expliquer simplement' }));
        expect(await screen.findByText(/Je ne sais pas : Relais n’a pas pu préparer une explication fiable/)).toBeInTheDocument();
    });

    it('explication tirée de la fiche, avec ce que la fiche ne dit pas', async () => {
        const user = userEvent.setup();
        withProgramInFile();
        benefitsApi.explainProgram.mockResolvedValueOnce({
            plain_explanation: 'Un crédit pour une déficience grave et prolongée.',
            who_it_may_help: ['Une personne limitée au quotidien'],
            steps: ['Remplir le formulaire T2201'],
            not_in_fiche: ['La fiche ne précise pas le montant.']
        });
        renderApp(`${BENEFITS}/credit-impot-personnes-handicapees`);
        await user.click(await screen.findByRole('button', { name: 'Expliquer simplement' }));
        expect(await screen.findByText('La fiche ne précise pas le montant.')).toBeInTheDocument();
        expect(benefitsApi.explainProgram).toHaveBeenCalledWith(program().id);
    });

    it('lettre : seul l’identifiant de la fiche part au serveur ; les noms sont ajoutés sur le téléphone', async () => {
        const user = userEvent.setup();
        withProgramInFile();
        careFilesApi.getCareRecipient.mockResolvedValue({
            care_file_id: FILE_ID,
            first_name: 'Roger',
            last_name: 'Gagnon',
            birth_year: 1947,
            living_setting: 'rpa',
            living_setting_since: null,
            residence_name: null,
            chsld_waitlist: true,
            chsld_waitlist_since: null
        } as never);
        benefitsApi.draftLetter.mockResolvedValueOnce('[DATE]\nAu nom de [NOM DE LA PERSONNE AIDÉE].\n[VOTRE TÉLÉPHONE]\n[VOTRE NOM]');
        renderApp(`${BENEFITS}/credit-impot-personnes-handicapees`);
        await user.click(await screen.findByRole('button', { name: 'Préparer la lettre' }));
        const letter = ((await screen.findByLabelText('Votre lettre (modifiable)')) as HTMLTextAreaElement).value;
        expect(letter).toContain('Au nom de Roger Gagnon.');
        expect(letter).toContain('[VOTRE TÉLÉPHONE]');
        expect(letter).toContain('Claire');
        expect(benefitsApi.draftLetter).toHaveBeenCalledWith(program().id, 'information_request');
        await user.click(screen.getByRole('button', { name: 'Enregistrer la lettre dans le dossier' }));
        await waitFor(() =>
            expect(benefitsApi.updateFileProgram).toHaveBeenCalledWith(
                'cf000000-0000-4000-8000-000000000001',
                expect.objectContaining({ letter_draft: expect.stringContaining('Roger Gagnon') })
            )
        );
    });
});

describe('administration', () => {
    it('réservée au rôle admin', async () => {
        owner();
        renderApp('/admin/programmes');
        expect(await screen.findByText('Cette section est réservée à l’administration de Relais.')).toBeInTheDocument();
    });

    it('une fiche avec un montant est refusée avec un message clair ; la vérification exige des initiales', async () => {
        const user = userEvent.setup();
        backend.session = fakeSession('aal2');
        backend.profile = { id: USER_ID, display_name: 'Ada', app_role: 'admin' };
        backend.consents = [consent('privacy_policy')];
        const target = backend.programs[0]!;
        renderApp(`/admin/programmes/${target.id}`);
        const summary = await screen.findByLabelText('Description factuelle');
        await user.clear(summary);
        await user.type(summary, 'Jusqu’à 1 000 $ par année.');
        await user.click(screen.getByLabelText('J’ai vérifié aujourd’hui cette fiche à la source officielle.'));
        await user.click(screen.getByRole('button', { name: 'Enregistrer la fiche' }));
        expect(await screen.findByText('Entrez vos initiales pour confirmer la vérification.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Vos initiales'), 'AL');
        benefitsApi.updateProgram.mockRejectedValueOnce(new ApiError('update_program', '23514'));
        await user.click(screen.getByRole('button', { name: 'Enregistrer la fiche' }));
        expect(await screen.findByText(/Refusé : la fiche contient un montant/)).toBeInTheDocument();
        expect(benefitsApi.updateProgram).toHaveBeenCalledWith(
            target.id,
            expect.objectContaining({ summary: 'Jusqu’à 1 000 $ par année.' }),
            expect.objectContaining({ verified_by: 'AL', verified_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
        );
    });
});
