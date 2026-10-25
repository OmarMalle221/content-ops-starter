import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { Button, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { files as tf } from '../../i18n/files.fr';
import { createCareFile } from '../../lib/careFiles';
import { fileKeys } from './useFile';

export function NewCareFilePage() {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [title, setTitle] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const trimmed = title.trim();
        if (trimmed.length === 0 || trimmed.length > 80) {
            setError(tf.titleError);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const id = await createCareFile(trimmed);
            await queryClient.invalidateQueries({ queryKey: fileKeys.myFiles(session?.user.id) });
            // Étape suivante : le consentement de la personne aidée, sans lequel rien ne peut être ajouté.
            navigate(`/dossiers/${id}/consentement`);
        } catch {
            setError(fr.app.genericError);
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <PageTitle>{tf.newTitle}</PageTitle>
            <p>{tf.newIntro}</p>
            <TextField
                label={tf.titleLabel}
                hint={tf.titleHint}
                error={error === tf.titleError ? error : null}
                name="title"
                maxLength={80}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
            />
            {error && error !== tf.titleError && <Notice tone="error">{error}</Notice>}
            <Button type="submit" disabled={busy}>
                {busy ? tf.creating : tf.create}
            </Button>
        </form>
    );
}
