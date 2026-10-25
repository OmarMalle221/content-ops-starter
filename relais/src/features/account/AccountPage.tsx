import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { queryKeys, useProfile } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, Card, Loading, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { deleteMyAccount, exportMyData, signOutLocally, updateDisplayName } from '../../lib/api';
import { logEvent } from '../../lib/log';

export function AccountPage() {
    const profile = useProfile();
    if (profile.isPending) return <Loading />;
    if (profile.isError) return <Notice tone="error">{fr.app.genericError}</Notice>;
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.account.title}</PageTitle>
            <NameSection initialName={profile.data.display_name ?? ''} />
            <ExportSection />
            <SignOutSection />
            <DeleteSection />
        </div>
    );
}

function NameSection({ initialName }: { initialName: string }) {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const [name, setName] = useState(initialName);
    const [status, setStatus] = useState<'idle' | 'saved' | 'error' | 'invalid'>('idle');

    async function submit(event: FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (!session || trimmed.length === 0 || trimmed.length > 80) {
            setStatus('invalid');
            return;
        }
        try {
            await updateDisplayName(session.user.id, trimmed);
            await queryClient.invalidateQueries({ queryKey: queryKeys.profile(session.user.id) });
            setStatus('saved');
        } catch {
            setStatus('error');
        }
    }

    return (
        <Card>
            <h2 className="text-xl font-bold">{fr.account.nameTitle}</h2>
            <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3">
                <TextField
                    label={fr.welcome.nameLabel}
                    hint={fr.welcome.nameHint}
                    error={status === 'invalid' ? fr.welcome.nameError : null}
                    name="display_name"
                    autoComplete="given-name"
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                {status === 'saved' && <Notice tone="success">{fr.account.nameSaved}</Notice>}
                {status === 'error' && <Notice tone="error">{fr.app.genericError}</Notice>}
                <Button type="submit" variant="secondary">
                    {fr.account.nameSave}
                </Button>
            </form>
        </Card>
    );
}

function ExportSection() {
    const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

    async function download() {
        setState('busy');
        try {
            const data = await exportMyData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `relais-mes-renseignements-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.append(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            logEvent('export_downloaded');
            setState('done');
        } catch {
            setState('error');
        }
    }

    return (
        <Card>
            <h2 className="text-xl font-bold">{fr.account.dataTitle}</h2>
            <p className="mt-2">{fr.account.dataText}</p>
            <div className="mt-3 flex flex-col gap-3">
                {state === 'done' && <Notice tone="success">{fr.account.dataDone}</Notice>}
                {state === 'error' && <Notice tone="error">{fr.app.genericError}</Notice>}
                <Button variant="secondary" onClick={() => void download()} disabled={state === 'busy'}>
                    {state === 'busy' ? fr.account.dataPreparing : fr.account.dataDownload}
                </Button>
            </div>
        </Card>
    );
}

function SignOutSection() {
    const navigate = useNavigate();
    return (
        <Card>
            <h2 className="text-xl font-bold">{fr.account.signOutTitle}</h2>
            <p className="mt-2">{fr.account.signOutText}</p>
            <Button
                variant="secondary"
                className="mt-3"
                onClick={() => {
                    // Quitter d'abord la page protégée, puis fermer la session.
                    navigate('/', { replace: true });
                    void signOutLocally();
                }}
            >
                {fr.account.signOut}
            </Button>
        </Card>
    );
}

function DeleteSection() {
    const navigate = useNavigate();
    const [understood, setUnderstood] = useState(false);
    const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');

    async function remove() {
        setState('busy');
        try {
            await deleteMyAccount();
            // Quitter d'abord la page protégée (avec le message), puis fermer la session.
            navigate('/', { replace: true, state: { notice: fr.account.deleted } });
            void signOutLocally();
        } catch {
            setState('error');
        }
    }

    return (
        <Card className="border-urgent">
            <h2 className="text-xl font-bold text-urgent-strong">{fr.account.deleteTitle}</h2>
            <p className="mt-2">{fr.account.deleteText}</p>
            <div className="mt-3 flex flex-col gap-3">
                <label className="flex min-h-12 cursor-pointer items-center gap-3 font-bold">
                    <input
                        type="checkbox"
                        className="size-6 accent-urgent"
                        checked={understood}
                        onChange={(e) => setUnderstood(e.target.checked)}
                    />
                    {fr.account.deleteConfirm}
                </label>
                {state === 'error' && <Notice tone="error">{fr.app.genericError}</Notice>}
                <Button variant="danger" disabled={!understood || state === 'busy'} onClick={() => void remove()}>
                    {state === 'busy' ? fr.account.deleting : fr.account.delete}
                </Button>
            </div>
        </Card>
    );
}
