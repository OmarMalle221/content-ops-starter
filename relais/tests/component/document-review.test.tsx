import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ExtractionDraft } from '../../src/shared/extraction/schema';
import {
    backend,
    careDocument,
    careFilesApi,
    consent,
    documentsApi,
    DOCUMENT_ID,
    fakeSession,
    FILE_ID,
    fileConsent,
    ownFile,
    USER_ID
} from './backend';
import { renderApp } from './render';

const DOC_PATH = `/dossiers/${FILE_ID}/documents/${DOCUMENT_ID}`;

function signedInOwner({ aiConsent = true }: { aiConsent?: boolean } = {}) {
    backend.session = fakeSession();
    backend.profile.display_name = 'Louise';
    backend.consents = [consent('privacy_policy'), consent('health_information')];
    ownFile();
    backend.file.consents = [
        fileConsent(),
        ...(aiConsent ? [fileConsent({ consent_type: 'ai_document_processing', text_version: '2026-10-28' })] : [])
    ];
}

function asMember(level: 'read_only' | 'coordination') {
    backend.session = fakeSession();
    backend.profile.display_name = 'Gilles';
    backend.consents = [consent('privacy_policy'), consent('health_information')];
    backend.file.members = [
        {
            care_file_id: FILE_ID,
            user_id: 'c0000000-0000-4000-8000-00000000000c',
            role: 'primary_caregiver',
            access_level: 'owner',
            joined_at: ''
        },
        { care_file_id: FILE_ID, user_id: USER_ID, role: 'family_member', access_level: level, joined_at: '' }
    ];
    backend.file.consents = [fileConsent()];
}

const DRAFT: ExtractionDraft = {
    schema_version: '1',
    document_type: 'discharge_summary',
    document_date: '2026-10-03',
    author: 'Dre Isabelle Fortin, gériatre',
    title: 'Résumé de départ de l’hôpital',
    plain_summary: null,
    medications: [
        {
            name: 'Metformine',
            dosage: '500 mg',
            frequency: '2 fois par jour',
            source_line: '- Metformine 500 mg 2 fois par jour',
            unverified: false
        },
        { name: 'Aspirine', dosage: '81 mg', frequency: null, source_line: 'Aspirine 81 mg', unverified: true }
    ],
    appointments: [
        {
            date: null,
            time: '10 h 30',
            place: 'clinique externe',
            purpose: 'Rendez-vous en gériatrie',
            source_line: 'Rendez-vous…',
            unverified: false
        }
    ],
    action_items: [{ text: 'Prise de sang au CLSC', source_line: 'À faire : prise de sang au CLSC', unverified: false }],
    timeline_events: [
        { date: '2026-10-03', event_type: 'discharge', title: 'Retour à la résidence', source_line: 'Retour…', unverified: false }
    ],
    legibility: 'clear',
    needs_review: true,
    review_reasons: ['summary_removed', 'not_in_source'],
    guard_flags: ['advice_language', 'not_in_source']
};

function withDraft() {
    backend.file.documents = [careDocument({ status: 'draft_ready', needs_review: true })];
    backend.file.extraction = {
        id: 'e1000000-0000-4000-8000-000000000001',
        documentId: DOCUMENT_ID,
        status: 'draft',
        method: 'ai',
        draft: DRAFT,
        confirmed: null,
        confirmedAt: null
    };
}

describe('relecture d’un brouillon', () => {
    it('montre les points à vérifier, le rappel Info-Santé tiré des ressources et les éléments marqués', async () => {
        signedInOwner();
        withDraft();
        renderApp(DOC_PATH);
        expect(await screen.findByRole('heading', { name: 'Vérifier le brouillon' })).toBeInTheDocument();
        expect(screen.getByText(/Le résumé automatique a été retiré/)).toBeInTheDocument();
        expect(screen.getByText(/ressemblait à un conseil/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Info-Santé : 811' })).toHaveAttribute('href', 'tel:811');

        const aspirin = screen.getByRole('group', { name: 'Médicament 2 : Aspirine' });
        expect(within(aspirin).getByText(/À vérifier : introuvable tel quel/)).toBeInTheDocument();
        expect(within(aspirin).getByRole('checkbox', { name: 'Garder cet élément' })).not.toBeChecked();
        const metformin = screen.getByRole('group', { name: 'Médicament 1 : Metformine' });
        expect(within(metformin).getByRole('checkbox', { name: 'Garder cet élément' })).toBeChecked();
        // Rendez-vous sans date : proposé, mais pas gardé d'office.
        const appointment = screen.getByRole('group', { name: 'Événement 2 : Rendez-vous en gériatrie' });
        expect(within(appointment).getByRole('checkbox', { name: 'Garder cet élément' })).not.toBeChecked();
        await waitFor(() => expect(documentsApi.logExtractionViewed).toHaveBeenCalledWith(FILE_ID, DOCUMENT_ID));
    });

    it('confirme ce qui est gardé, avec les corrections', async () => {
        const user = userEvent.setup();
        signedInOwner();
        withDraft();
        renderApp(DOC_PATH);
        const metformin = await screen.findByRole('group', { name: 'Médicament 1 : Metformine' });
        const dosage = within(metformin).getByLabelText('Dose (facultatif)');
        await user.clear(dosage);
        await user.type(dosage, '500 mg (1 comprimé)');
        await user.type(screen.getByLabelText('Résumé'), 'Retour à la résidence.');
        await user.click(screen.getByRole('button', { name: 'Confirmer et ajouter au dossier' }));
        await waitFor(() =>
            expect(documentsApi.confirmDocument).toHaveBeenCalledWith(DOCUMENT_ID, 'e1000000-0000-4000-8000-000000000001', {
                document: {
                    title: 'Résumé de départ de l’hôpital',
                    doc_type: 'discharge_summary',
                    doc_date: '2026-10-03',
                    author: 'Dre Isabelle Fortin, gériatre',
                    needs_review: true
                },
                summary: 'Retour à la résidence.',
                medications: [{ name: 'Metformine', dosage: '500 mg (1 comprimé)', frequency: '2 fois par jour' }],
                timeline_events: [{ event_type: 'discharge', occurred_on: '2026-10-03', title: 'Retour à la résidence', description: '' }],
                action_items: [{ text: 'Prise de sang au CLSC' }]
            })
        );
    });

    it('refuse un événement gardé sans date', async () => {
        const user = userEvent.setup();
        signedInOwner();
        withDraft();
        renderApp(DOC_PATH);
        const appointment = await screen.findByRole('group', { name: 'Événement 2 : Rendez-vous en gériatrie' });
        await user.click(within(appointment).getByRole('checkbox', { name: 'Garder cet élément' }));
        await user.click(screen.getByRole('button', { name: 'Confirmer et ajouter au dossier' }));
        expect(await screen.findByText('Événement 2 : entrez une date, ou décochez « Garder ».')).toBeInTheDocument();
        expect(documentsApi.confirmDocument).not.toHaveBeenCalled();
    });

    it('une saisie libre qui évoque une crise affiche l’écran d’urgence', async () => {
        const user = userEvent.setup();
        signedInOwner();
        withDraft();
        renderApp(DOC_PATH);
        await user.type(await screen.findByLabelText('Résumé'), 'Je n’en peux plus, je veux mourir');
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByRole('link', { name: 'Appeler le 911' })).toHaveAttribute('href', 'tel:911');
    });

    it('rejeter le brouillon entier', async () => {
        const user = userEvent.setup();
        signedInOwner();
        withDraft();
        renderApp(DOC_PATH);
        await user.click(await screen.findByRole('button', { name: 'Rejeter tout le brouillon' }));
        await waitFor(() => expect(documentsApi.discardExtraction).toHaveBeenCalledWith('e1000000-0000-4000-8000-000000000001'));
    });
});

describe('saisie à la main et accès', () => {
    it('photo sans lecture automatique : la famille note elle-même le contenu', async () => {
        const user = userEvent.setup();
        signedInOwner();
        backend.file.documents = [careDocument({ mime_type: 'image/jpeg', page_count: null, status: 'uploaded' })];
        renderApp(DOC_PATH);
        expect(await screen.findByText('Relais ne lit pas encore les photos automatiquement.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Lire automatiquement' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Noter moi-même le contenu' }));
        expect(await screen.findByRole('heading', { name: 'Noter le contenu du document' })).toBeInTheDocument();
        await user.type(screen.getByLabelText('Titre'), 'Ordonnance');
        await user.click(screen.getByRole('button', { name: 'Ajouter un médicament' }));
        await user.type(screen.getByLabelText('Nom'), 'Atorvastatine');
        await user.click(screen.getByRole('button', { name: 'Confirmer et ajouter au dossier' }));
        await waitFor(() =>
            expect(documentsApi.confirmDocument).toHaveBeenCalledWith(
                DOCUMENT_ID,
                null,
                expect.objectContaining({
                    document: expect.objectContaining({ title: 'Ordonnance', needs_review: true }),
                    medications: [{ name: 'Atorvastatine', dosage: '', frequency: '' }]
                })
            )
        );
    });

    it('PDF sans autorisation de lecture automatique : aucune lecture proposée', async () => {
        signedInOwner({ aiConsent: false });
        backend.file.documents = [careDocument()];
        renderApp(DOC_PATH);
        expect(await screen.findByText('La lecture automatique n’est pas autorisée pour ce dossier.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Lire automatiquement' })).not.toBeInTheDocument();
    });

    it('lecture automatique relancée après une panne', async () => {
        const user = userEvent.setup();
        signedInOwner();
        backend.file.documents = [careDocument({ status: 'failed', extraction_error: 'ai_unavailable' })];
        renderApp(DOC_PATH);
        await user.click(await screen.findByRole('button', { name: 'Réessayer la lecture automatique' }));
        await waitFor(() => expect(documentsApi.extractDocument).toHaveBeenCalledWith(DOCUMENT_ID));
    });

    it('lecture seule : le brouillon attend la famille, rien n’est modifiable', async () => {
        asMember('read_only');
        withDraft();
        renderApp(DOC_PATH);
        expect(await screen.findByText(/doit vérifier ce brouillon/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Confirmer et ajouter au dossier' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Supprimer le document' })).not.toBeInTheDocument();
    });

    it('coordination : ni onglet Documents ni Chronologie', async () => {
        asMember('coordination');
        renderApp(`/dossiers/${FILE_ID}`);
        const nav = await screen.findByRole('navigation', { name: 'Sections du dossier' });
        expect(within(nav).queryByRole('link', { name: 'Documents' })).not.toBeInTheDocument();
        expect(within(nav).queryByRole('link', { name: 'Chronologie' })).not.toBeInTheDocument();
        expect(within(nav).getByRole('link', { name: 'Contacts' })).toBeInTheDocument();
    });
});

describe('consentement de lecture automatique', () => {
    it('distinct du consentement au dossier, enregistré séparément', async () => {
        const user = userEvent.setup();
        signedInOwner({ aiConsent: false });
        renderApp(`/dossiers/${FILE_ID}/consentement`);
        const section = await screen.findByRole('region', { name: 'Lecture automatique des documents (facultatif)' });
        expect(within(section).getByText('Lecture automatique non autorisée.')).toBeInTheDocument();
        await user.click(within(section).getByRole('radio', { name: /a signé le formulaire/ }));
        await user.click(within(section).getByLabelText(/J’atteste que mon proche a lu/));
        await user.click(within(section).getByRole('button', { name: 'Enregistrer l’autorisation' }));
        await waitFor(() =>
            expect(careFilesApi.recordFileConsent).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'ai_document_processing', version: '2026-10-28', grantedBy: 'care_recipient_signed_form' })
            )
        );
    });
});
