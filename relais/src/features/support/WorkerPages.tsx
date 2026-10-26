// Tableau de suivi des intervenantes (rôle relais_worker + vérification en deux étapes, imposée par la
// base et par RequireStaffMfa). Les notes internes ne passent pas par le détecteur de détresse : ce sont
// des notes professionnelles, pas la parole d'une personne aidante.
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useProfile } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, buttonClass, Card, Loading, Notice, PageTitle, RadioGroup } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { support as ts } from '../../i18n/support.fr';
import { dialable, formatDate, formatTime } from '../../lib/format';
import { addSupportNote, setSupportStatus, type SupportRequest } from '../../lib/support';
import { useMyFiles } from '../files/useFile';
import { supportKeys, useSupportBoard, useSupportNotes } from './useSupport';

function WorkerOnly({ children, title }: { children: ReactNode; title?: string }) {
    const profile = useProfile();
    if (profile.isPending) return <Loading />;
    if (profile.data?.app_role !== 'relais_worker') {
        return (
            <div className="flex flex-col gap-5">
                {title && <PageTitle>{title}</PageTitle>}
                <Notice tone="info">{ts.workerOnly}</Notice>
            </div>
        );
    }
    return <>{children}</>;
}

type Filter = 'new' | 'mine' | 'open' | 'closed';

export function WorkerBoardPage() {
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{ts.workerTitle}</PageTitle>
            <WorkerOnly>
                <Board />
            </WorkerOnly>
        </div>
    );
}

function Board() {
    const { session } = useSession();
    const board = useSupportBoard(true);
    const [filter, setFilter] = useState<Filter>('new');
    if (board.isPending) return <Loading />;
    const all = board.data ?? [];
    const lists: Record<Filter, SupportRequest[]> = {
        new: all.filter((r) => r.status === 'new'),
        mine: all.filter((r) => r.status === 'assigned' && r.assigned_worker_id === session?.user.id),
        open: all.filter((r) => r.status !== 'closed'),
        closed: all.filter((r) => r.status === 'closed')
    };
    // Écran d'urgence d'abord, puis les plus anciennes.
    const shown = [...lists[filter]].sort(
        (a, b) =>
            Number(b.origin === 'distress_screen') - Number(a.origin === 'distress_screen') || a.created_at.localeCompare(b.created_at)
    );

    return (
        <>
            <p>{ts.workerIntro}</p>
            <RadioGroup
                legend={ts.filterLegend}
                name="board-filter"
                value={filter}
                options={(['new', 'mine', 'open', 'closed'] as const).map((f) => ({ value: f, label: ts.filters[f](lists[f].length) }))}
                onChange={setFilter}
            />
            {shown.length === 0 && <p className="text-muted">{ts.none}</p>}
            <ul className="flex list-none flex-col gap-3 p-0">
                {shown.map((r) => (
                    <li key={r.id}>
                        <Link
                            to={`/intervenante/demandes/${r.id}`}
                            className={`flex flex-col gap-1 rounded-xl border-2 bg-surface p-4 ${r.origin === 'distress_screen' ? 'border-urgent' : 'border-line'}`}
                        >
                            <span className="font-bold text-brand underline underline-offset-4">{r.contact_name}</span>
                            <span className={r.origin === 'distress_screen' ? 'font-bold text-urgent' : ''}>{ts.origins[r.origin]}</span>
                            <span className="text-muted">{ts.receivedOn(formatDate(r.created_at), formatTime(r.created_at))}</span>
                            {r.status === 'assigned' && (
                                <span className="text-muted">
                                    {r.assigned_worker_id === session?.user.id ? ts.assignedToMe : ts.assignedToColleague}
                                </span>
                            )}
                        </Link>
                    </li>
                ))}
            </ul>
        </>
    );
}

export function WorkerRequestPage() {
    return (
        <WorkerOnly title={ts.workerTitle}>
            <RequestDetail />
        </WorkerOnly>
    );
}

function RequestDetail() {
    const { requestId = '' } = useParams();
    const { session } = useSession();
    const queryClient = useQueryClient();
    const board = useSupportBoard(true);
    const myFiles = useMyFiles();
    const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    if (board.isPending) return <Loading />;
    const request = board.data?.find((r) => r.id === requestId);
    if (!request) {
        return (
            <div className="flex flex-col gap-4">
                <Notice tone="error">{ts.requestNotFound}</Notice>
                <Link to="/intervenante" className="font-bold text-brand underline underline-offset-4">
                    {ts.backToBoard}
                </Link>
            </div>
        );
    }
    const mine = request.assigned_worker_id === session?.user.id;
    const sharedFile = request.care_file_id ? myFiles.data?.some((f) => f.file.id === request.care_file_id) : false;

    async function change(next: 'assigned' | 'closed') {
        try {
            await setSupportStatus(requestId, next);
            await queryClient.invalidateQueries({ queryKey: supportKeys.board });
            setStatus({ tone: 'success', text: ts.statusSaved });
        } catch {
            setStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <Link to="/intervenante" className="self-start font-bold text-brand underline underline-offset-4">
                {ts.backToBoard}
            </Link>
            <PageTitle>{request.contact_name}</PageTitle>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <p className={request.origin === 'distress_screen' ? 'font-bold text-urgent' : 'font-bold'}>{ts.origins[request.origin]}</p>
            <p className="text-muted">{ts.receivedOn(formatDate(request.created_at), formatTime(request.created_at))}</p>
            <p>{ts.statusLabels[request.status]}</p>
            {request.status === 'assigned' && <p className="text-muted">{mine ? ts.assignedToMe : ts.assignedToColleague}</p>}

            <section aria-labelledby="contact-title" className="flex flex-col gap-2">
                <h2 id="contact-title" className="text-xl font-bold">
                    {ts.contact}
                </h2>
                {request.preferred_contact === 'phone' && request.phone ? (
                    <a
                        href={`tel:${dialable(request.phone)}`}
                        className={buttonClass('primary', 'self-start')}
                        aria-label={`${ts.callName(request.contact_name)} : ${request.phone}`}
                    >
                        {request.phone}
                    </a>
                ) : request.email ? (
                    <a
                        href={`mailto:${request.email}`}
                        className={buttonClass('primary', 'self-start break-all')}
                        aria-label={`${ts.writeName(request.contact_name)} : ${request.email}`}
                    >
                        {request.email}
                    </a>
                ) : null}
                {request.preferred_times && (
                    <p>
                        <span className="font-bold">{ts.timesLabel} :</span> {request.preferred_times}
                    </p>
                )}
                {request.message && (
                    <div>
                        <p className="font-bold">{ts.messageLabel}</p>
                        <p className="whitespace-pre-line rounded-lg bg-surface p-3">{request.message}</p>
                    </div>
                )}
                {request.care_file_id &&
                    (sharedFile ? (
                        <Link to={`/dossiers/${request.care_file_id}`} className={buttonClass('secondary', 'self-start')}>
                            {ts.fileOpen}
                        </Link>
                    ) : (
                        <p className="text-muted">{ts.fileNotShared}</p>
                    ))}
            </section>

            <div className="flex flex-wrap gap-2">
                {(request.status === 'new' || (request.status === 'assigned' && !mine)) && (
                    <Button onClick={() => void change('assigned')}>{ts.take}</Button>
                )}
                {request.status !== 'closed' && (
                    <Button variant="secondary" onClick={() => void change('closed')}>
                        {ts.close}
                    </Button>
                )}
                {request.status === 'closed' && (
                    <Button variant="secondary" onClick={() => void change('assigned')}>
                        {ts.reopen}
                    </Button>
                )}
            </div>

            <Notes requestId={request.id} />
        </div>
    );
}

function Notes({ requestId }: { requestId: string }) {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const notes = useSupportNotes(requestId, true);
    const [body, setBody] = useState('');
    const [error, setError] = useState<string | null>(null);
    const id = useId();

    async function add(event: FormEvent) {
        event.preventDefault();
        if (!body.trim()) return;
        try {
            await addSupportNote(requestId, body);
            setBody('');
            setError(null);
            await queryClient.invalidateQueries({ queryKey: supportKeys.notes(requestId) });
        } catch {
            setError(fr.app.genericError);
        }
    }

    return (
        <section aria-labelledby="notes-title" className="flex flex-col gap-3">
            <h2 id="notes-title" className="text-xl font-bold">
                {ts.notesTitle}
            </h2>
            {(notes.data ?? []).length === 0 && <p className="text-muted">{ts.noNotes}</p>}
            <ul className="flex list-none flex-col gap-2 p-0">
                {(notes.data ?? []).map((n) => (
                    <li key={n.id}>
                        <Card>
                            <p className="text-muted">
                                {ts.noteBy(
                                    n.author_id === session?.user.id ? ts.you : ts.colleague,
                                    `${formatDate(n.created_at)}, ${formatTime(n.created_at)}`
                                )}
                            </p>
                            <p className="whitespace-pre-line">{n.body}</p>
                        </Card>
                    </li>
                ))}
            </ul>
            <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2">
                <label htmlFor={id} className="font-bold">
                    {ts.noteLabel}
                </label>
                <p id={`${id}-hint`} className="text-muted">
                    {ts.notesHint}
                </p>
                <textarea
                    id={id}
                    aria-describedby={`${id}-hint`}
                    className="min-h-28 rounded-lg border-2 border-muted bg-surface p-3 text-lg"
                    value={body}
                    maxLength={2000}
                    onChange={(e) => setBody(e.target.value)}
                />
                <Button type="submit" variant="secondary" className="self-start">
                    {ts.addNote}
                </Button>
                {error && <Notice tone="error">{error}</Notice>}
            </form>
        </section>
    );
}
