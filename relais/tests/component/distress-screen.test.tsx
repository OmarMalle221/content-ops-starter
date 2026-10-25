// Critère d'acceptation : une série de phrases types de détresse déclenche toujours l'écran de ressources.
// Chaque phrase du corpus est saisie dans le vrai champ de saisie libre, et l'écran doit apparaître avec
// les numéros tirés de la table de ressources.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FreeTextField } from '../../src/features/distress/FreeTextField';
import { mustNotTrigger, mustTrigger } from '../unit/distress-corpus';
import { api, backend } from './backend';
import { renderWithProviders } from './render';

function Journal() {
    const [value, setValue] = useState('');
    return <FreeTextField label="Journal de bord" value={value} onValueChange={setValue} />;
}

function typeInto(text: string) {
    fireEvent.change(screen.getByLabelText('Journal de bord'), { target: { value: text } });
}

function distressDialog() {
    return screen.queryByRole('dialog');
}

describe('écran de ressources d’urgence', () => {
    it.each(mustTrigger.map((p) => p.text))('s’affiche pour « %s »', async (text) => {
        renderWithProviders(<Journal />);
        typeInto(text);
        const dialog = distressDialog();
        expect(dialog).not.toBeNull();
        const call911 = await within(dialog as HTMLElement).findByRole('link', { name: 'Appeler le 911' });
        expect(call911).toHaveAttribute('href', 'tel:911');
    });

    it.each(mustNotTrigger)('ne s’affiche pas pour « %s »', (text) => {
        renderWithProviders(<Journal />);
        typeInto(text);
        expect(distressDialog()).toBeNull();
    });

    it('garde la saisie et rend le focus au champ à la fermeture', async () => {
        const user = userEvent.setup();
        renderWithProviders(<Journal />);
        const field = screen.getByLabelText('Journal de bord');
        await user.click(field);
        typeInto('Honnêtement je veux en finir');
        await user.click(screen.getByRole('button', { name: 'Revenir à ma saisie' }));
        expect(distressDialog()).toBeNull();
        expect(field).toHaveValue('Honnêtement je veux en finir');
        expect(field).toHaveFocus();
    });

    it('ne se rouvre pas à chaque lettre pour la même situation', async () => {
        const user = userEvent.setup();
        renderWithProviders(<Journal />);
        typeInto('Je veux mourir');
        await user.click(screen.getByRole('button', { name: 'Revenir à ma saisie' }));
        typeInto('Je veux mourir. Demain');
        expect(distressDialog()).toBeNull();
        typeInto('Je veux mourir. Demain, il me frappe');
        expect(distressDialog()).not.toBeNull();
    });

    it('met le 9-8-8 en premier pour des idées suicidaires, le 911 en cas de danger', async () => {
        renderWithProviders(<Journal />);
        typeInto('Je veux mourir');
        let dialog = distressDialog() as HTMLElement;
        await within(dialog).findByRole('link', { name: 'Appeler le 911' });
        expect(within(dialog).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('9-8-8');
        expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Vous n’avez pas à traverser ça sans aide.');
        await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Revenir à ma saisie' }));

        typeInto('Elle ne respire plus');
        dialog = distressDialog() as HTMLElement;
        expect(within(dialog).getAllByRole('heading', { level: 3 })[0]).toHaveTextContent('Urgence 911');
        expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent(
            'Si quelqu’un est en danger, appelez le 911 maintenant.'
        );
    });

    it('affiche les numéros de la table de ressources quand elle répond', async () => {
        backend.resources = backend.resources.map((r) => (r.slug === 'info-social-811' ? { ...r, name: 'Info-Social 811 (vérifié)' } : r));
        renderWithProviders(<Journal />);
        typeInto("Je n'en peux plus");
        const dialog = distressDialog() as HTMLElement;
        expect(await within(dialog).findByRole('heading', { name: 'Info-Social 811 (vérifié)' })).toBeInTheDocument();
        expect(api.listHelpResources).toHaveBeenCalled();
    });

    it('affiche la copie de secours si la table est injoignable', async () => {
        backend.failResources = true;
        renderWithProviders(<Journal />);
        typeInto('Je vais me tuer');
        const dialog = distressDialog() as HTMLElement;
        await waitFor(() => expect(api.listHelpResources).toHaveBeenCalled());
        expect(within(dialog).getByRole('link', { name: 'Appeler le 911' })).toHaveAttribute('href', 'tel:911');
        expect(within(dialog).getByRole('link', { name: 'Texto au 988' })).toHaveAttribute('href', 'sms:988');
    });

    describe('avec <dialog> modal natif', () => {
        const proto = HTMLDialogElement.prototype as unknown as { showModal?: (this: HTMLDialogElement) => void };
        afterEach(() => {
            delete proto.showModal;
        });

        it('ouvre le dialogue en mode modal', () => {
            proto.showModal = function (this: HTMLDialogElement) {
                this.setAttribute('open', '');
            };
            renderWithProviders(<Journal />);
            act(() => typeInto('Il me frappe'));
            const dialog = distressDialog() as HTMLElement;
            expect(dialog).toHaveAttribute('open');
            expect(dialog).not.toHaveAttribute('aria-modal');
            expect(within(dialog).getByRole('heading', { level: 2 })).toHaveFocus();
        });
    });
});
