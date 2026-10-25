import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSession } from '../../app/session';
import { Button, Card, Loading, Notice, PageTitle } from '../../components/ui';
import { coordination as tc } from '../../i18n/coordination.fr';
import { fr } from '../../i18n/fr';
import { addJournalEntry, deleteJournalEntry, updateJournalEntry, type JournalEntry } from '../../lib/coordination';
import { formatDate, formatTime } from '../../lib/format';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from '../files/FileLayout';
import { useMembers } from '../files/useFile';
import { coordKeys, memberName, useJournal } from './useCoordination';

type Status = { tone: 'success' | 'error'; text: string } | null;

/** Carnet de bord : notes datées et signées, zone « santé ». Chacun modifie seulement ses propres notes. */
export function JournalPage() {
    const { file, access } = useFileContext();
    const queryClient = useQueryClient();
    const canRead = access.canRead('health');
    const journal = useJournal(file.id, canRead);
    const members = useMembers(file.id);
    const { session } = useSession();
    const [body, setBody] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<Status>(null);
    const [busy, setBusy] = useState(false);

    if (!canRead) {
        return (
            <div className="flex flex-col gap-5">
                <PageTitle>{tc.journalTitle}</PageTitle>
                <Notice tone="info">{tc.journalHealthOnly}</Notice>
            </div>
        );
    }
    if (journal.isPending) return <Loading />;

    async function add(event: FormEvent) {
        event.preventDefault();
        if (!body.trim()) return setError(tc.entryError);
        setError(null);
        setBusy(true);
        try {
            await addJournalEntry(file.id, body);
            setBody('');
            await queryClient.invalidateQueries({ queryKey: coordKeys.journal(file.id) });
            setStatus({ tone: 'success', text: tc.entrySaved });
        } catch {
            setStatus({ tone: 'error', text: fr.app.genericError });
        } finally {
            setBusy(false);
        }
    }

    const entries = journal.data ?? [];
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tc.journalTitle}</PageTitle>
            <p>{tc.journalIntro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            {access.canWrite('health') && (
                <form onSubmit={(e) => void add(e)} noValidate className="flex flex-col gap-2">
                    <FreeTextField
                        label={tc.newEntry}
                        hint={tc.newEntryHint}
                        error={error}
                        value={body}
                        maxLength={4000}
                        onValueChange={setBody}
                    />
                    <Button type="submit" className="self-start" disabled={busy}>
                        {tc.addEntry}
                    </Button>
                </form>
            )}
            {entries.length === 0 && <p className="text-muted">{tc.noEntries}</p>}
            <ul className="flex list-none flex-col gap-3 p-0">
                {entries.map((entry) => (
                    <li key={entry.id}>
                        <Entry
                            entry={entry}
                            author={memberName(members.data, entry.author_id, session?.user.id) ?? tc.someone}
                            mine={entry.author_id === session?.user.id && access.canWrite('health')}
                            onStatus={setStatus}
                        />
                    </li>
                ))}
            </ul>
        </div>
    );
}

function Entry({ entry, author, mine, onStatus }: { entry: JournalEntry; author: string; mine: boolean; onStatus: (s: Status) => void }) {
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [body, setBody] = useState(entry.body);
    const refresh = () => queryClient.invalidateQueries({ queryKey: coordKeys.journal(entry.care_file_id) });
    const when = `${formatDate(entry.created_at)}, ${formatTime(entry.created_at)}`;
    const edited = new Date(entry.updated_at).getTime() - new Date(entry.created_at).getTime() > 60_000;

    async function save() {
        if (!body.trim()) return;
        try {
            await updateJournalEntry(entry.id, body);
            await refresh();
            setEditing(false);
            onStatus({ tone: 'success', text: tc.entryUpdated });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    async function remove() {
        try {
            await deleteJournalEntry(entry.id);
            await refresh();
            onStatus({ tone: 'success', text: tc.entryDeleted });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <Card className="flex flex-col gap-2">
            <p className="text-muted">
                {tc.entryBy(author, when)} {edited && tc.edited}
            </p>
            {editing ? (
                <>
                    <FreeTextField label={tc.editEntryLabel} value={body} maxLength={4000} onValueChange={setBody} />
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void save()}>{tc.save}</Button>
                        <Button variant="secondary" onClick={() => setEditing(false)}>
                            {tc.cancel}
                        </Button>
                    </div>
                </>
            ) : (
                <p className="whitespace-pre-line">{entry.body}</p>
            )}
            {mine && !editing && (
                <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setEditing(true)} aria-label={`${tc.edit} : ${tc.entryBy(author, when)}`}>
                        {tc.edit}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => setConfirming(true)}
                        aria-label={`${tc.remove} : ${tc.entryBy(author, when)}`}
                    >
                        {tc.remove}
                    </Button>
                </div>
            )}
            {confirming && (
                <div role="group" aria-label={tc.confirmDeleteEntry} className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4">
                    <p className="font-bold">{tc.confirmDeleteEntry}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="danger" onClick={() => void remove()}>
                            {tc.remove}
                        </Button>
                        <Button variant="secondary" onClick={() => setConfirming(false)}>
                            {tc.cancel}
                        </Button>
                    </div>
                </div>
            )}
        </Card>
    );
}
