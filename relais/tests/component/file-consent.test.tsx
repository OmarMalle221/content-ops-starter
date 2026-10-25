import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backend, careFilesApi, consent, fakeSession, FILE_ID, fileConsent, ownFile } from './backend';
import { renderApp } from './render';

function signedInOwner() {
    backend.session = fakeSession();
    backend.profile.display_name = 'Louise';
    backend.consents = [consent('privacy_policy')];
    ownFile();
}

describe('consentement de la personne aidée', () => {
    it('le dossier sans consentement le signale, et la page propose les deux fondements', async () => {
        signedInOwner();
        renderApp(`/dossiers/${FILE_ID}`);
        expect(await screen.findByText(/enregistrez le consentement de votre proche/)).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('link', { name: 'Enregistrer le consentement' }));
        const group = await screen.findByRole('group', { name: 'Qui donne son accord ?' });
        expect(within(group).getAllByRole('radio')).toHaveLength(2);
    });

    it('exige l’attestation avant d’enregistrer un formulaire signé', async () => {
        const user = userEvent.setup();
        signedInOwner();
        renderApp(`/dossiers/${FILE_ID}/consentement`);
        await user.click(await screen.findByRole('radio', { name: /a signé le formulaire/ }));
        expect(screen.getByRole('link', { name: 'Imprimer le formulaire à signer' })).toHaveAttribute(
            'href',
            `/dossiers/${FILE_ID}/formulaire-consentement`
        );
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        expect(await screen.findByText('Cochez l’attestation pour continuer.')).toBeInTheDocument();
        expect(careFilesApi.recordFileConsent).not.toHaveBeenCalled();

        await user.click(screen.getByLabelText(/J’atteste que mon proche a lu/));
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        await waitFor(() =>
            expect(careFilesApi.recordFileConsent).toHaveBeenCalledWith({
                fileId: FILE_ID,
                version: '2026-10-27',
                grantedBy: 'care_recipient_signed_form',
                legalBasis: 'person_consents'
            })
        );
    });

    it('un représentant légal doit être nommé', async () => {
        const user = userEvent.setup();
        signedInOwner();
        renderApp(`/dossiers/${FILE_ID}/consentement`);
        await user.click(await screen.findByRole('radio', { name: 'Son représentant légal donne son accord' }));
        await user.selectOptions(screen.getByLabelText('Fondement'), 'tutorship');
        await user.click(screen.getByLabelText(/J’atteste que cette personne est son représentant légal/));
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        expect(await screen.findByText('Entrez le nom du représentant légal.')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Nom du représentant légal'), 'Me Tremblay');
        await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
        await waitFor(() =>
            expect(careFilesApi.recordFileConsent).toHaveBeenCalledWith(
                expect.objectContaining({ grantedBy: 'legal_representative', legalBasis: 'tutorship', representativeName: 'Me Tremblay' })
            )
        );
    });

    it('après un retrait par la personne aidée, le formulaire signé n’est plus proposé', async () => {
        signedInOwner();
        const recipientId = 'a0000000-0000-4000-8000-0000000000b8';
        backend.file.members.push({
            care_file_id: FILE_ID,
            user_id: recipientId,
            role: 'care_recipient',
            access_level: 'read_only',
            joined_at: '2026-10-27T11:00:00Z'
        });
        backend.file.consents = [
            fileConsent({ granted_by: 'care_recipient_in_app', revoked_at: '2026-10-28T09:00:00Z', revoked_by: recipientId })
        ];
        renderApp(`/dossiers/${FILE_ID}/consentement`);
        expect(await screen.findByText(/Votre proche a retiré son accord lui-même/)).toBeInTheDocument();
        expect(screen.queryByRole('radio', { name: /a signé le formulaire/ })).toBeNull();
        expect(screen.getByRole('radio', { name: 'Son représentant légal donne son accord' })).toBeChecked();
    });

    it('un consentement en vigueur se retire après confirmation', async () => {
        const user = userEvent.setup();
        signedInOwner();
        const active = fileConsent();
        backend.file.consents = [active];
        renderApp(`/dossiers/${FILE_ID}/consentement`);
        expect(await screen.findByRole('heading', { name: 'Consentement en vigueur' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Retirer le consentement' }));
        const confirm = screen.getByRole('group', { name: 'Retirer le consentement de la personne aidée ?' });
        await user.click(within(confirm).getByRole('button', { name: 'Confirmer le retrait' }));
        await waitFor(() => expect(careFilesApi.revokeFileConsent).toHaveBeenCalledWith(active.id));
    });

    it('un non-membre voit « dossier introuvable »', async () => {
        backend.session = fakeSession();
        backend.profile.display_name = 'Louise';
        backend.consents = [consent('privacy_policy')];
        renderApp(`/dossiers/${FILE_ID}`);
        expect(await screen.findByText('Ce dossier n’existe pas, ou vous n’y avez plus accès.')).toBeInTheDocument();
    });
});
