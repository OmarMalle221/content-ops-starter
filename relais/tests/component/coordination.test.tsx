import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDate } from '../../src/lib/format';
import {
    APPOINTMENT_ID,
    appointment,
    backend,
    careFilesApi,
    consent,
    coordinationApi,
    DOCUMENT_ID,
    careDocument,
    fakeSession,
    FILE_ID,
    fileConsent,
    ownFile,
    task,
    USER_ID
} from './backend';
import { renderApp } from './render';

const OTHER = 'c0000000-0000-4000-8000-0000000000c0';
const day = (offset: number) => localDate(new Date(Date.now() + offset * 86_400_000));
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function owner() {
    backend.session = fakeSession();
    backend.profile.display_name = 'Louise';
    backend.consents = [consent('privacy_policy'), consent('health_information')];
    ownFile();
    backend.file.members.push({ care_file_id: FILE_ID, user_id: OTHER, role: 'family_member', access_level: 'full', joined_at: '' });
    backend.file.consents = [fileConsent()];
}

function coordinationMember() {
    backend.session = fakeSession();
    backend.profile.display_name = 'Gilles';
    backend.consents = [consent('privacy_policy')];
    backend.file.members = [
        { care_file_id: FILE_ID, user_id: OTHER, role: 'primary_caregiver', access_level: 'owner', joined_at: '' },
        { care_file_id: FILE_ID, user_id: USER_ID, role: 'family_member', access_level: 'coordination', joined_at: '' }
    ];
    backend.file.consents = [fileConsent()];
}

afterEach(() => vi.restoreAllMocks());

describe('tâches', () => {
    it('à faire triées par échéance, retard signalé, faites repliées, filtre « mes tâches »', async () => {
        const user = userEvent.setup();
        owner();
        backend.file.tasks = [
            task({ title: 'Remplir le formulaire', due_on: day(5), assignee_id: OTHER }),
            task({ title: 'Appeler la pharmacie', due_on: day(-2), assignee_id: USER_ID }),
            task({ title: 'Acheter des bas', status: 'done', completed_at: '2026-10-28T14:00:00Z', completed_by: USER_ID })
        ];
        renderApp(`/dossiers/${FILE_ID}/taches`);
        const todo = await screen.findByRole('region', { name: 'À faire' });
        const items = within(todo).getAllByRole('listitem');
        expect(items.map((li) => within(li).getByRole('checkbox').closest('label')?.textContent)).toEqual([
            'Appeler la pharmacie',
            'Remplir le formulaire'
        ]);
        expect(within(items[0]!).getByText(/^En retard : /)).toBeInTheDocument();
        expect(within(items[0]!).getByText('Responsable : Louise (vous)')).toBeInTheDocument();
        expect(screen.getByText('Voir la tâche faite')).toBeInTheDocument();
        await user.click(screen.getByRole('radio', { name: 'Mes tâches' }));
        expect(within(todo).getAllByRole('listitem')).toHaveLength(1);
        expect(screen.getByRole('link', { name: 'Activer les rappels par courriel' })).toHaveAttribute('href', '/mes-consentements');
    });

    it('nouvelle tâche : responsable et échéance', async () => {
        const user = userEvent.setup();
        owner();
        renderApp(`/dossiers/${FILE_ID}/taches`);
        await user.click(await screen.findByRole('button', { name: 'Ajouter une tâche' }));
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        expect(await screen.findByText('Écrivez la tâche en quelques mots.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Quoi faire'), 'Prendre rendez-vous au CLSC');
        await user.selectOptions(screen.getByLabelText('Qui s’en occupe'), USER_ID);
        fireEvent.change(screen.getByLabelText('À faire au plus tard le (facultatif)'), { target: { value: '2026-11-15' } });
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        await waitFor(() =>
            expect(coordinationApi.createTask).toHaveBeenCalledWith(
                FILE_ID,
                { title: 'Prendre rendez-vous au CLSC', details: null, assignee_id: USER_ID, due_on: '2026-11-15' },
                {}
            )
        );
        expect(await screen.findByText('Tâche enregistrée.')).toBeInTheDocument();
    });

    it('créée depuis un « à faire » de document : titre proposé, lien vers la source', async () => {
        const user = userEvent.setup();
        owner();
        renderApp(`/dossiers/${FILE_ID}/taches?titre=${encodeURIComponent('Prendre rendez-vous en cardiologie')}&document=${DOCUMENT_ID}`);
        expect(await screen.findByLabelText('Quoi faire')).toHaveValue('Prendre rendez-vous en cardiologie');
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        await waitFor(() =>
            expect(coordinationApi.createTask).toHaveBeenCalledWith(
                FILE_ID,
                expect.objectContaining({ title: 'Prendre rendez-vous en cardiologie' }),
                {
                    source_document_id: DOCUMENT_ID,
                    care_file_program_id: undefined
                }
            )
        );
    });

    it('cocher une tâche : tout de suite, puis rétablie si l’enregistrement est refusé', async () => {
        const user = userEvent.setup();
        owner();
        backend.file.tasks = [task({ title: 'Appeler la pharmacie' })];
        coordinationApi.setTaskDone.mockRejectedValueOnce(new Error('refusé'));
        renderApp(`/dossiers/${FILE_ID}/taches`);
        const box = await screen.findByRole('checkbox', { name: 'Appeler la pharmacie' });
        await user.click(box);
        await waitFor(() => expect(box).not.toBeChecked());
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(coordinationApi.setTaskDone).toHaveBeenCalledWith(backend.file.tasks[0]!.id, true);
    });
});

describe('agenda', () => {
    it('rendez-vous à venir groupés par jour ; formulaire à l’heure du Québec ; fin avant début refusée', async () => {
        const user = userEvent.setup();
        owner();
        backend.file.appointments = [
            appointment({ starts_at: inHours(30), title: 'Prise de sang' }),
            appointment({ id: 'a1000000-0000-4000-8000-000000000002', starts_at: inHours(-48), title: 'Ancien' })
        ];
        renderApp(`/dossiers/${FILE_ID}/agenda`);
        expect(await screen.findByRole('link', { name: /Prise de sang/ })).toBeInTheDocument();
        expect(screen.getByText('Voir le rendez-vous passé')).toBeInTheDocument();
        await user.click(screen.getByRole('link', { name: 'Ajouter un rendez-vous' }));
        await user.type(await screen.findByLabelText('Objet du rendez-vous'), 'Clinique de gériatrie');
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-02' } });
        fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '10:00' } });
        fireEvent.change(screen.getByLabelText('Heure de fin (facultatif)'), { target: { value: '09:00' } });
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        expect(await screen.findByText('L’heure de fin doit venir après l’heure du rendez-vous.')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Heure de fin (facultatif)'), { target: { value: '11:15' } });
        await user.selectOptions(screen.getByLabelText('Qui accompagne'), OTHER);
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        await waitFor(() =>
            expect(coordinationApi.createAppointment).toHaveBeenCalledWith(FILE_ID, {
                title: 'Clinique de gériatrie',
                starts_at: '2026-11-02T15:00:00.000Z',
                ends_at: '2026-11-02T16:15:00.000Z',
                location: null,
                contact_id: null,
                companion_id: OTHER,
                notes: null
            })
        );
    });

    it('fiche : fichier .ics avec titre, heure et lieu seulement ; questions à poser', async () => {
        const user = userEvent.setup();
        owner();
        backend.file.appointments = [appointment({ starts_at: inHours(30) })];
        backend.file.questions = [
            {
                id: 'e1000000-0000-4000-8000-0000000000aa',
                appointment_id: APPOINTMENT_ID,
                question: 'Faut-il une prise de sang ?',
                position: 0,
                created_by: USER_ID
            }
        ];
        const blobs: Blob[] = [];
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
            blobs.push(blob as Blob);
            return 'blob:relais';
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        renderApp(`/dossiers/${FILE_ID}/agenda/${APPOINTMENT_ID}`);
        await user.click(await screen.findByRole('button', { name: 'Ajouter à mon calendrier' }));
        const ics = await blobs[0]!.text();
        expect(ics).toContain('SUMMARY:Clinique de gériatrie');
        expect(ics).toContain('LOCATION:Hôpital fictif');
        expect(ics).not.toContain('Apporter la carte');
        expect(ics).not.toContain('prise de sang');
        expect(screen.getByText('Faut-il une prise de sang ?')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Nouvelle question'), 'Peut-il conduire ?');
        await user.click(screen.getByRole('button', { name: 'Ajouter la question' }));
        await waitFor(() => expect(coordinationApi.addQuestion).toHaveBeenCalledWith(FILE_ID, APPOINTMENT_ID, 'Peut-il conduire ?', 1));
        expect(screen.getByRole('link', { name: 'Préparer ce rendez-vous' })).toBeInTheDocument();
    });

    it('membre « coordination » : agenda et tâches, sans questions, sans page de préparation ni carnet', async () => {
        coordinationMember();
        backend.file.appointments = [appointment({ starts_at: inHours(30) })];
        renderApp(`/dossiers/${FILE_ID}/agenda/${APPOINTMENT_ID}`);
        expect(await screen.findByRole('heading', { level: 1, name: 'Clinique de gériatrie' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Préparer ce rendez-vous' })).not.toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: 'Questions à poser' })).not.toBeInTheDocument();
        expect(coordinationApi.listQuestions).not.toHaveBeenCalled();
        const nav = screen.getByRole('navigation', { name: 'Sections du dossier' });
        expect(within(nav).getByRole('link', { name: 'Tâches' })).toBeInTheDocument();
        expect(within(nav).queryByRole('link', { name: 'Carnet' })).not.toBeInTheDocument();
    });
});

describe('préparer un rendez-vous', () => {
    it('seulement des faits du dossier, chacun avec sa source ; impression notée', async () => {
        const user = userEvent.setup();
        owner();
        const appt = appointment({ starts_at: '2026-11-02T15:00:00.000Z' });
        backend.file.appointments = [appt];
        backend.file.documents = [careDocument({ status: 'confirmed', title: 'Résumé de départ', doc_date: '2026-10-20' })];
        backend.file.timeline = [
            {
                id: 'e1000000-0000-4000-8000-000000000001',
                care_file_id: FILE_ID,
                event_type: 'discharge',
                occurred_on: '2026-10-20',
                title: 'Retour à domicile',
                description: null,
                source_type: 'document',
                source_document_id: DOCUMENT_ID,
                created_by: USER_ID,
                created_at: '2026-10-21T10:00:00Z'
            },
            {
                id: 'e1000000-0000-4000-8000-000000000002',
                care_file_id: FILE_ID,
                event_type: 'service_change',
                occurred_on: '2026-09-15',
                title: 'Début du ménage',
                description: null,
                source_type: 'manual',
                source_document_id: null,
                created_by: USER_ID,
                created_at: '2026-09-15T10:00:00Z'
            },
            {
                id: 'e1000000-0000-4000-8000-000000000003',
                care_file_id: FILE_ID,
                event_type: 'hospitalization',
                occurred_on: '2026-03-01',
                title: 'Hospitalisation ancienne',
                description: null,
                source_type: 'manual',
                source_document_id: null,
                created_by: USER_ID,
                created_at: '2026-03-02T10:00:00Z'
            }
        ];
        backend.file.medications = [
            {
                id: 'e2000000-0000-4000-8000-000000000001',
                source_document_id: DOCUMENT_ID,
                name_as_written: 'Metformine',
                dosage_as_written: '500 mg',
                frequency_as_written: '2 fois par jour',
                document_date: '2026-10-20',
                created_at: '2026-10-21T10:00:00Z'
            }
        ];
        backend.file.questions = [
            {
                id: 'e3000000-0000-4000-8000-000000000001',
                appointment_id: APPOINTMENT_ID,
                question: 'Faut-il une prise de sang ?',
                position: 0,
                created_by: USER_ID
            }
        ];
        careFilesApi.getCareRecipient.mockResolvedValue({
            care_file_id: FILE_ID,
            first_name: 'Roger',
            last_name: 'Gagnon',
            birth_year: 1947,
            living_setting: 'rpa',
            living_setting_since: null,
            residence_name: 'Résidence fictive',
            chsld_waitlist: true,
            chsld_waitlist_since: '2026-08-15'
        } as never);
        const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

        renderApp(`/dossiers/${FILE_ID}/agenda/${APPOINTMENT_ID}/preparer`);
        expect(await screen.findByRole('heading', { level: 1, name: 'Préparer le rendez-vous' })).toBeInTheDocument();
        const facts = screen.getAllByTestId('prep-fact');
        expect(facts).toHaveLength(3); // 2 changements récents + 1 médicament ; l'hospitalisation de mars est trop ancienne
        for (const fact of facts) expect(within(fact).getByText(/^Source : /)).toBeInTheDocument();
        expect(screen.getAllByText('Source : document « Résumé de départ » du 20 octobre 2026')).toHaveLength(2);
        expect(screen.getByText('Source : noté à la main par Louise')).toBeInTheDocument();
        expect(screen.queryByText(/Hospitalisation ancienne/)).not.toBeInTheDocument();
        expect(screen.getByText('Metformine — 500 mg — 2 fois par jour')).toBeInTheDocument();
        expect(screen.getByText('Faut-il une prise de sang ?')).toBeInTheDocument();
        expect(screen.getByText('Source : questions notées par la famille')).toBeInTheDocument();
        expect(screen.getByText(/En attente d’une place en CHSLD depuis le 15 août 2026/)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Imprimer' }));
        await waitFor(() => expect(print).toHaveBeenCalled());
        expect(coordinationApi.logPrepSheetPrinted).toHaveBeenCalledWith(FILE_ID, APPOINTMENT_ID);
    });
});

describe('carnet de bord', () => {
    it('notes signées ; seules les siennes se modifient ; une note de détresse ouvre l’aide immédiate', async () => {
        const user = userEvent.setup();
        owner();
        backend.file.journal = [
            {
                id: 'e4000000-0000-4000-8000-000000000001',
                care_file_id: FILE_ID,
                author_id: OTHER,
                body: 'Visite de 14 h.',
                created_at: '2026-10-29T18:00:00Z',
                updated_at: '2026-10-29T18:00:00Z'
            },
            {
                id: 'e4000000-0000-4000-8000-000000000002',
                care_file_id: FILE_ID,
                author_id: USER_ID,
                body: 'Maman a bien dormi.',
                created_at: '2026-10-28T12:00:00Z',
                updated_at: '2026-10-28T12:00:00Z'
            }
        ];
        renderApp(`/dossiers/${FILE_ID}/carnet`);
        expect(await screen.findByText('Visite de 14 h.')).toBeInTheDocument();
        const theirs = screen.getByText('Visite de 14 h.').closest('li') as HTMLElement;
        const mine = screen.getByText('Maman a bien dormi.').closest('li') as HTMLElement;
        expect(within(theirs).queryByRole('button', { name: /^Modifier/ })).not.toBeInTheDocument();
        expect(within(theirs).getByText(/^Un membre, 29 octobre 2026/)).toBeInTheDocument();
        expect(within(mine).getByRole('button', { name: /^Modifier/ })).toBeInTheDocument();
        expect(within(mine).getByText(/^Louise \(vous\), 28 octobre 2026/)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Ajouter au carnet' }));
        expect(await screen.findByText('Écrivez votre note avant de l’ajouter.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Nouvelle note'), 'Elle était souriante.');
        await user.click(screen.getByRole('button', { name: 'Ajouter au carnet' }));
        await waitFor(() => expect(coordinationApi.addJournalEntry).toHaveBeenCalledWith(FILE_ID, 'Elle était souriante.'));

        await act(async () => {
            fireEvent.change(screen.getByLabelText('Nouvelle note'), { target: { value: 'Je n’en peux plus, je veux mourir' } });
        });
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('membre « coordination » : carnet réservé à la zone santé', async () => {
        coordinationMember();
        renderApp(`/dossiers/${FILE_ID}/carnet`);
        expect(
            await screen.findByText('Le carnet est réservé aux membres qui ont accès aux renseignements de santé du dossier.')
        ).toBeInTheDocument();
        expect(coordinationApi.listJournal).not.toHaveBeenCalled();
    });
});

describe('aperçu du dossier', () => {
    it('cette semaine : prochains rendez-vous et mes tâches', async () => {
        owner();
        backend.file.appointments = [
            appointment({ starts_at: inHours(30) }),
            appointment({ id: 'a1000000-0000-4000-8000-000000000003', starts_at: inHours(24 * 20), title: 'Plus tard' })
        ];
        backend.file.tasks = [
            task({ assignee_id: USER_ID }),
            task({ assignee_id: USER_ID, status: 'done', completed_at: '2026-10-28T14:00:00Z' })
        ];
        renderApp(`/dossiers/${FILE_ID}`);
        const week = await screen.findByRole('heading', { name: 'Cette semaine' });
        const card = week.closest('section') as HTMLElement;
        expect(await within(card).findByRole('link', { name: /Clinique de gériatrie/ })).toBeInTheDocument();
        expect(within(card).queryByText(/Plus tard/)).not.toBeInTheDocument();
        expect(within(card).getByText('1 tâche à faire pour vous.')).toBeInTheDocument();
    });
});
