import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMyConsents } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, Card, Checkbox, Loading, Notice, PageTitle, RadioGroup, SelectField, TextField } from '../../components/ui';
import { coordination as tc } from '../../i18n/coordination.fr';
import { fr } from '../../i18n/fr';
import { activeConsent } from '../../lib/consents';
import { createTask, deleteTask, setTaskDone, updateTask, type Task, type TaskInput, type TaskOrigin } from '../../lib/coordination';
import { formatDate, localDate } from '../../lib/format';
import { useFilePrograms, usePrograms } from '../benefits/useBenefits';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from '../files/FileLayout';
import { useMembers } from '../files/useFile';
import { coordKeys, memberName, memberOptions, useTasks } from './useCoordination';

type Status = { tone: 'success' | 'error'; text: string } | null;
type Members = ReturnType<typeof useMembers>['data'];

/** Tâches partagées : à faire (les plus urgentes d'abord), faites (repliées), « mes tâches ». */
export function TasksPage() {
    const { file, access } = useFileContext();
    const { session } = useSession();
    const myId = session?.user.id;
    const tasks = useTasks(file.id);
    const members = useMembers(file.id);
    const [params, setParams] = useSearchParams();
    const canWrite = access.canWrite('coordination');
    // Création depuis un document (« à faire ») ou une démarche : titre proposé, lien vers la source.
    const prefill = canWrite && params.get('titre') ? params.get('titre') : null;
    const origin: TaskOrigin = {
        source_document_id: params.get('document') ?? undefined,
        care_file_program_id: params.get('demarche') ?? undefined
    };
    const [filter, setFilter] = useState<'all' | 'mine'>('all');
    const [editing, setEditing] = useState<string | 'new' | null>(prefill ? 'new' : null);
    const [status, setStatus] = useState<Status>(null);

    if (tasks.isPending || members.isPending) return <Loading />;
    const list = (tasks.data ?? []).filter((t) => filter === 'all' || t.assignee_id === myId);
    const today = localDate();
    const todo = list
        .filter((t) => t.status === 'todo')
        .sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') || a.created_at.localeCompare(b.created_at));
    const done = list.filter((t) => t.status === 'done').sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));

    const closeForm = (s: Status) => {
        setEditing(null);
        setStatus(s);
        if (prefill) setParams({}, { replace: true });
    };

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tc.tasksTitle}</PageTitle>
            <p>{tc.tasksIntro}</p>
            <RemindersHint />
            {status && <Notice tone={status.tone}>{status.text}</Notice>}

            {canWrite &&
                (editing === 'new' ? (
                    <TaskForm
                        fileId={file.id}
                        current={null}
                        initialTitle={prefill ?? ''}
                        origin={prefill ? origin : {}}
                        members={members.data}
                        myId={myId}
                        onDone={closeForm}
                    />
                ) : (
                    <Button className="self-start" onClick={() => setEditing('new')}>
                        {tc.addTask}
                    </Button>
                ))}

            <RadioGroup
                legend={tc.filterLegend}
                name="task-filter"
                value={filter}
                options={[
                    { value: 'all', label: tc.filterAll },
                    { value: 'mine', label: tc.filterMine }
                ]}
                onChange={setFilter}
            />

            <section aria-labelledby="todo-title" className="flex flex-col gap-3">
                <h2 id="todo-title" className="text-2xl font-bold">
                    {tc.todoTitle}
                </h2>
                {todo.length === 0 && <p className="text-muted">{tc.noTasks}</p>}
                <ul className="flex list-none flex-col gap-3 p-0">
                    {todo.map((task) => (
                        <li key={task.id}>
                            {editing === task.id ? (
                                <TaskForm
                                    fileId={file.id}
                                    current={task}
                                    initialTitle={task.title}
                                    origin={{}}
                                    members={members.data}
                                    myId={myId}
                                    onDone={closeForm}
                                />
                            ) : (
                                <TaskItem
                                    task={task}
                                    today={today}
                                    members={members.data}
                                    myId={myId}
                                    canWrite={canWrite}
                                    onEdit={() => setEditing(task.id)}
                                    onStatus={setStatus}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            </section>

            {done.length > 0 && (
                <details>
                    <summary className="min-h-12 py-3 font-bold text-brand">{tc.doneCount(done.length)}</summary>
                    <ul className="flex list-none flex-col gap-3 p-0">
                        {done.map((task) => (
                            <li key={task.id}>
                                <TaskItem
                                    task={task}
                                    today={today}
                                    members={members.data}
                                    myId={myId}
                                    canWrite={canWrite}
                                    onEdit={() => setEditing(task.id)}
                                    onStatus={setStatus}
                                />
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

/** Rappels par courriel : consentement distinct, géré dans « Mes consentements ». */
function RemindersHint() {
    const consents = useMyConsents();
    if (!consents.data) return null;
    if (activeConsent(consents.data, 'email_reminders')) return <p className="text-muted">{tc.remindersOn}</p>;
    return (
        <p>
            {tc.remindersOff}{' '}
            <Link to="/mes-consentements" className="font-bold text-brand underline underline-offset-4">
                {tc.remindersLink}
            </Link>
        </p>
    );
}

function TaskItem({
    task,
    today,
    members,
    myId,
    canWrite,
    onEdit,
    onStatus
}: {
    task: Task;
    today: string;
    members: Members;
    myId: string | undefined;
    canWrite: boolean;
    onEdit: () => void;
    onStatus: (s: Status) => void;
}) {
    const queryClient = useQueryClient();
    const { file, access } = useFileContext();
    const [done, setDone] = useState(task.status === 'done');
    const [confirming, setConfirming] = useState(false);
    const refresh = () => queryClient.invalidateQueries({ queryKey: coordKeys.tasks(task.care_file_id) });
    const assignee = memberName(members, task.assignee_id, myId);
    const overdue = task.status === 'todo' && task.due_on !== null && task.due_on < today;

    // Cochée tout de suite ; rétablie si l'enregistrement échoue.
    async function toggle(next: boolean) {
        setDone(next);
        try {
            await setTaskDone(task.id, next);
            await refresh();
        } catch {
            setDone(!next);
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    async function remove() {
        try {
            await deleteTask(task.id);
            await refresh();
            onStatus({ tone: 'success', text: tc.taskDeleted });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <Card className="flex flex-col gap-1">
            {canWrite ? (
                <Checkbox
                    label={<span className="text-lg font-bold">{task.title}</span>}
                    checked={done}
                    onChange={(e) => void toggle(e.target.checked)}
                />
            ) : (
                <p className="text-lg font-bold">
                    {task.status === 'done' ? '✓ ' : ''}
                    {task.title}
                </p>
            )}
            {task.details && <p className="whitespace-pre-line">{task.details}</p>}
            <p className="text-muted">{assignee ? tc.assignedTo(assignee) : tc.unassigned}</p>
            {task.status === 'todo' && task.due_on && (
                <p className={overdue ? 'font-bold text-urgent' : ''}>
                    {overdue ? `${tc.overdue} : ` : task.due_on === today ? `${tc.dueToday} : ` : ''}
                    {tc.due(formatDate(task.due_on))}
                </p>
            )}
            {task.status === 'done' && task.completed_at && (
                <p className="text-muted">{tc.doneOn(formatDate(task.completed_at), memberName(members, task.completed_by, myId))}</p>
            )}
            <TaskSource
                task={task}
                canReadHealth={access.canRead('health')}
                canReadBenefits={access.canRead('benefits')}
                fileId={file.id}
            />
            {canWrite && (
                <div className="mt-2 flex flex-wrap gap-2">
                    {task.status === 'todo' && (
                        <Button variant="secondary" onClick={onEdit} aria-label={`${tc.edit} : ${task.title}`}>
                            {tc.edit}
                        </Button>
                    )}
                    <Button variant="secondary" onClick={() => setConfirming(true)} aria-label={`${tc.remove} : ${task.title}`}>
                        {tc.remove}
                    </Button>
                </div>
            )}
            {confirming && (
                <div
                    role="group"
                    aria-label={tc.confirmDeleteTask(task.title)}
                    className="mt-2 flex flex-col gap-3 rounded-lg bg-urgent-soft p-4"
                >
                    <p className="font-bold">{tc.confirmDeleteTask(task.title)}</p>
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

/** Lien vers le document ou la démarche d'origine, pour qui peut les voir. */
function TaskSource({
    task,
    canReadHealth,
    canReadBenefits,
    fileId
}: {
    task: Task;
    canReadHealth: boolean;
    canReadBenefits: boolean;
    fileId: string;
}) {
    const filePrograms = useFilePrograms(fileId, canReadBenefits && task.care_file_program_id !== null);
    const programs = usePrograms();
    if (task.source_document_id && canReadHealth) {
        return (
            <p>
                {tc.fromDocument} —{' '}
                <Link
                    to={`../documents/${task.source_document_id}`}
                    relative="path"
                    className="font-bold text-brand underline underline-offset-4"
                >
                    {tc.seeSource}
                    <span className="sr-only"> : {task.title}</span>
                </Link>
            </p>
        );
    }
    if (task.care_file_program_id && canReadBenefits) {
        const fileProgram = filePrograms.data?.find((fp) => fp.id === task.care_file_program_id);
        const slug = programs.data?.find((p) => p.id === fileProgram?.program_id)?.slug;
        if (!slug) return null;
        return (
            <p>
                {tc.fromProgram} —{' '}
                <Link to={`../droits/${slug}`} relative="path" className="font-bold text-brand underline underline-offset-4">
                    {tc.seeSource}
                    <span className="sr-only"> : {task.title}</span>
                </Link>
            </p>
        );
    }
    return null;
}

function TaskForm({
    fileId,
    current,
    initialTitle,
    origin,
    members,
    myId,
    onDone
}: {
    fileId: string;
    current: Task | null;
    initialTitle: string;
    origin: TaskOrigin;
    members: Members;
    myId: string | undefined;
    onDone: (s: Status) => void;
}) {
    const queryClient = useQueryClient();
    const [title, setTitle] = useState(initialTitle.slice(0, 160));
    const [details, setDetails] = useState(current?.details ?? '');
    const [assignee, setAssignee] = useState(current?.assignee_id ?? '');
    const [dueOn, setDueOn] = useState(current?.due_on ?? '');
    const [errors, setErrors] = useState<{ title?: string; dueOn?: string }>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const next = {
            title: title.trim() ? undefined : tc.taskTitleError,
            dueOn: dueOn === '' || /^\d{4}-\d{2}-\d{2}$/.test(dueOn) ? undefined : tc.dueOnError
        };
        setErrors(next);
        if (next.title || next.dueOn) return;
        const input: TaskInput = {
            title: title.trim(),
            details: details.trim() || null,
            assignee_id: assignee || null,
            due_on: dueOn || null
        };
        setBusy(true);
        setError(null);
        try {
            if (current) await updateTask(current.id, input);
            else await createTask(fileId, input, origin);
            await queryClient.invalidateQueries({ queryKey: coordKeys.tasks(fileId) });
            onDone({ tone: 'success', text: tc.taskSaved });
        } catch {
            setError(fr.app.genericError);
        } finally {
            setBusy(false);
        }
    }

    const heading = current ? tc.editTaskTitle : tc.newTaskTitle;
    return (
        <form
            onSubmit={submit}
            noValidate
            aria-label={heading}
            className="flex flex-col gap-4 rounded-xl border-2 border-brand bg-surface p-4"
        >
            <h2 className="text-xl font-bold">{heading}</h2>
            <FreeTextField
                compact
                label={tc.taskTitle}
                hint={tc.taskTitleHint}
                error={errors.title ?? null}
                value={title}
                maxLength={160}
                rows={2}
                onValueChange={setTitle}
            />
            <FreeTextField compact label={tc.taskDetails} value={details} maxLength={2000} onValueChange={setDetails} />
            <SelectField
                label={tc.assignee}
                value={assignee}
                options={memberOptions(members, myId)}
                onChange={(e) => setAssignee(e.target.value)}
            />
            <TextField label={tc.dueOn} type="date" value={dueOn} error={errors.dueOn ?? null} onChange={(e) => setDueOn(e.target.value)} />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                    {tc.save}
                </Button>
                <Button variant="secondary" onClick={() => onDone(null)}>
                    {tc.cancel}
                </Button>
            </div>
        </form>
    );
}
