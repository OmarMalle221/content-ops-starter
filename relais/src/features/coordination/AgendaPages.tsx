// Agenda partagé : liste des rendez-vous, formulaire, fiche d'un rendez-vous (questions à poser, ajout au
// calendrier du téléphone). La page « Préparer un rendez-vous » est dans PrepSheetPage.tsx.
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useSession } from '../../app/session';
import { Button, buttonClass, Loading, Notice, PageTitle, SelectField, TextField } from '../../components/ui';
import { coordination as tc } from '../../i18n/coordination.fr';
import { fr } from '../../i18n/fr';
import {
    addQuestion,
    createAppointment,
    deleteAppointment,
    deleteQuestion,
    updateAppointment,
    type Appointment
} from '../../lib/coordination';
import { downloadText } from '../../lib/download';
import { dialable, formatDay, formatTime, localDate, localTime, zonedToIso } from '../../lib/format';
import { buildIcs, icsFileName } from '../../shared/calendar/ics';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from '../files/FileLayout';
import { useContacts, useMembers } from '../files/useFile';
import { coordKeys, memberName, memberOptions, useAppointments, useQuestions } from './useCoordination';

const ONE_HOUR = 60 * 60 * 1000;

/** Un rendez-vous est passé une fois terminé (une heure après le début s'il n'a pas d'heure de fin). */
export function isPast(appointment: Appointment, now: number): boolean {
    const end = appointment.ends_at ? new Date(appointment.ends_at).getTime() : new Date(appointment.starts_at).getTime() + ONE_HOUR;
    return end < now;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function AgendaPage() {
    const { file, access } = useFileContext();
    const { session } = useSession();
    const appointments = useAppointments(file.id);
    const members = useMembers(file.id);
    const [now] = useState(() => Date.now());
    if (appointments.isPending) return <Loading />;

    const list = appointments.data ?? [];
    const upcoming = list.filter((a) => !isPast(a, now));
    const past = list.filter((a) => isPast(a, now)).reverse();
    const days = [...new Set(upcoming.map((a) => localDate(a.starts_at)))];

    const item = (a: Appointment) => (
        <li key={a.id}>
            <Link
                to={a.id}
                className="flex flex-col gap-1 rounded-xl border-2 border-line bg-surface p-4 hover:border-brand focus-visible:border-brand"
            >
                <span className="font-bold text-brand underline underline-offset-4">{a.title}</span>
                <span>
                    {formatTime(a.starts_at)}
                    {a.location ? ` — ${a.location}` : ''}
                </span>
                <span className="text-muted">
                    {tc.with} : {memberName(members.data, a.companion_id, session?.user.id) ?? tc.nobody}
                </span>
            </Link>
        </li>
    );

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tc.agendaTitle}</PageTitle>
            <p>{tc.agendaIntro}</p>
            {access.canWrite('coordination') && (
                <Link to="nouveau" className={buttonClass('primary', 'self-start')}>
                    {tc.addAppointment}
                </Link>
            )}
            <section aria-labelledby="upcoming-title" className="flex flex-col gap-3">
                <h2 id="upcoming-title" className="text-2xl font-bold">
                    {tc.upcomingTitle}
                </h2>
                {days.length === 0 && <p className="text-muted">{tc.noAppointments}</p>}
                {days.map((day) => (
                    <div key={day} className="flex flex-col gap-2">
                        <h3 className="text-xl font-bold">{capitalize(formatDay(day))}</h3>
                        <ul className="flex list-none flex-col gap-2 p-0">
                            {upcoming.filter((a) => localDate(a.starts_at) === day).map(item)}
                        </ul>
                    </div>
                ))}
            </section>
            {past.length > 0 && (
                <details>
                    <summary className="min-h-12 py-3 font-bold text-brand">{tc.pastCount(past.length)}</summary>
                    <ul className="flex list-none flex-col gap-2 p-0">
                        {past.map((a) => (
                            <li key={a.id}>
                                <Link to={a.id} className="flex flex-col rounded-lg bg-surface p-3 text-brand underline underline-offset-4">
                                    {capitalize(formatDay(a.starts_at))} — {a.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

// ------------------------------------------------------------------------------------- formulaire
export function AppointmentEditPage() {
    const { appointmentId } = useParams();
    const { file, access } = useFileContext();
    const appointments = useAppointments(file.id);
    if (appointments.isPending) return <Loading />;
    const current = appointmentId ? appointments.data?.find((a) => a.id === appointmentId) : null;
    if (appointmentId && !current) return <Notice tone="error">{tc.appointmentNotFound}</Notice>;
    if (!access.canWrite('coordination')) return <Notice tone="info">{tc.agendaReadOnly}</Notice>;
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{current ? tc.editAppointmentTitle : tc.newAppointmentTitle}</PageTitle>
            <AppointmentForm fileId={file.id} current={current ?? null} />
        </div>
    );
}

function AppointmentForm({ fileId, current }: { fileId: string; current: Appointment | null }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { session } = useSession();
    const members = useMembers(fileId);
    const contacts = useContacts(fileId);
    const [form, setForm] = useState({
        title: current?.title ?? '',
        date: current ? localDate(current.starts_at) : '',
        start: current ? localTime(current.starts_at) : '',
        end: current?.ends_at ? localTime(current.ends_at) : '',
        location: current?.location ?? '',
        contactId: current?.contact_id ?? '',
        companionId: current?.companion_id ?? '',
        notes: current?.notes ?? ''
    });
    const [errors, setErrors] = useState<Partial<Record<'title' | 'date' | 'start' | 'end', string>>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

    async function submit(event: FormEvent) {
        event.preventDefault();
        const next: typeof errors = {};
        if (!form.title.trim()) next.title = tc.appointmentTitleError;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) next.date = tc.dateError;
        if (!/^\d{2}:\d{2}$/.test(form.start)) next.start = tc.startTimeError;
        if (form.end && (!/^\d{2}:\d{2}$/.test(form.end) || form.end <= form.start)) next.end = tc.endTimeError;
        setErrors(next);
        if (Object.keys(next).length > 0) return;
        const input = {
            title: form.title.trim(),
            starts_at: zonedToIso(form.date, form.start),
            ends_at: form.end ? zonedToIso(form.date, form.end) : null,
            location: form.location.trim() || null,
            contact_id: form.contactId || null,
            companion_id: form.companionId || null,
            notes: form.notes.trim() || null
        };
        setBusy(true);
        setError(null);
        try {
            const id = current ? current.id : await createAppointment(fileId, input);
            if (current) await updateAppointment(current.id, input);
            await queryClient.invalidateQueries({ queryKey: coordKeys.appointments(fileId) });
            navigate(`/dossiers/${fileId}/agenda/${id}`, { state: { notice: tc.appointmentSaved } });
        } catch {
            setError(fr.app.genericError);
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <FreeTextField
                compact
                label={tc.appointmentTitle}
                hint={tc.appointmentTitleHint}
                error={errors.title ?? null}
                value={form.title}
                maxLength={160}
                rows={2}
                onValueChange={(v) => set({ title: v })}
            />
            <TextField
                label={tc.date}
                type="date"
                value={form.date}
                error={errors.date ?? null}
                onChange={(e) => set({ date: e.target.value })}
            />
            <TextField
                label={tc.startTime}
                type="time"
                value={form.start}
                error={errors.start ?? null}
                onChange={(e) => set({ start: e.target.value })}
            />
            <TextField
                label={tc.endTime}
                type="time"
                value={form.end}
                error={errors.end ?? null}
                onChange={(e) => set({ end: e.target.value })}
            />
            <TextField label={tc.location} value={form.location} maxLength={240} onChange={(e) => set({ location: e.target.value })} />
            <SelectField
                label={tc.contact}
                value={form.contactId}
                options={[{ value: '', label: tc.noContact }, ...(contacts.data ?? []).map((c) => ({ value: c.id, label: c.name }))]}
                onChange={(e) => set({ contactId: e.target.value })}
            />
            <SelectField
                label={tc.companion}
                value={form.companionId}
                options={memberOptions(members.data, session?.user.id, true)}
                onChange={(e) => set({ companionId: e.target.value })}
            />
            <FreeTextField
                label={tc.notes}
                hint={tc.notesHint}
                value={form.notes}
                maxLength={2000}
                onValueChange={(v) => set({ notes: v })}
            />
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                    {tc.save}
                </Button>
                <Link to={current ? `../${current.id}` : '..'} relative="path" className={buttonClass('secondary')}>
                    {tc.cancel}
                </Link>
            </div>
        </form>
    );
}

// ----------------------------------------------------------------------------------- fiche
export function AppointmentPage() {
    const { appointmentId = '' } = useParams();
    const { file, access } = useFileContext();
    const { session } = useSession();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const appointments = useAppointments(file.id);
    const members = useMembers(file.id);
    const contacts = useContacts(file.id);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (appointments.isPending) return <Loading />;
    const appointment = appointments.data?.find((a) => a.id === appointmentId);
    if (!appointment) {
        return (
            <div className="flex flex-col gap-4">
                <Notice tone="error">{tc.appointmentNotFound}</Notice>
                <Link to=".." relative="path" className="font-bold text-brand underline underline-offset-4">
                    {tc.backToAgenda}
                </Link>
            </div>
        );
    }
    const contact = contacts.data?.find((c) => c.id === appointment.contact_id);
    const canWrite = access.canWrite('coordination');

    async function remove() {
        try {
            await deleteAppointment(appointmentId);
            await queryClient.invalidateQueries({ queryKey: coordKeys.appointments(file.id) });
            navigate(`/dossiers/${file.id}/agenda`, { state: { notice: tc.appointmentDeleted } });
        } catch {
            setError(fr.app.genericError);
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <Link to=".." relative="path" className="self-start font-bold text-brand underline underline-offset-4">
                {tc.backToAgenda}
            </Link>
            <PageTitle>{appointment.title}</PageTitle>
            {error && <Notice tone="error">{error}</Notice>}
            <dl className="grid gap-1">
                <dt className="font-bold">{tc.when}</dt>
                <dd>
                    {capitalize(formatDay(appointment.starts_at))},{' '}
                    {tc.timeRange(formatTime(appointment.starts_at), appointment.ends_at ? formatTime(appointment.ends_at) : null)}
                </dd>
                {appointment.location && (
                    <>
                        <dt className="font-bold">{tc.where}</dt>
                        <dd>{appointment.location}</dd>
                    </>
                )}
                <dt className="font-bold">{tc.with}</dt>
                <dd>{memberName(members.data, appointment.companion_id, session?.user.id) ?? tc.nobody}</dd>
                {contact && (
                    <>
                        <dt className="font-bold">{tc.contactLabel}</dt>
                        <dd>
                            {contact.name}
                            {contact.organization ? ` (${contact.organization})` : ''}
                        </dd>
                    </>
                )}
            </dl>
            {contact?.phone && (
                <a
                    href={`tel:${dialable(contact.phone)}`}
                    className={buttonClass('secondary', 'self-start')}
                    aria-label={tc.call(contact.name)}
                >
                    {contact.phone}
                </a>
            )}
            {appointment.notes && <p className="whitespace-pre-line rounded-lg bg-surface p-4">{appointment.notes}</p>}

            <div className="flex flex-col gap-2">
                <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() =>
                        downloadText(
                            buildIcs({
                                id: appointment.id,
                                title: appointment.title,
                                startsAt: appointment.starts_at,
                                endsAt: appointment.ends_at,
                                location: appointment.location
                            }),
                            icsFileName(appointment.starts_at),
                            'text/calendar'
                        )
                    }
                >
                    {tc.addToCalendar}
                </Button>
                <p className="text-muted">{tc.addToCalendarHint}</p>
            </div>
            {access.canRead('health') && (
                <Link to="preparer" className={buttonClass('primary', 'self-start')}>
                    {tc.prepare}
                </Link>
            )}

            {access.canRead('health') && <Questions appointment={appointment} canWrite={access.canWrite('health')} />}

            {canWrite && (
                <div className="flex flex-wrap gap-2">
                    <Link to="modifier" className={buttonClass('secondary')}>
                        {tc.edit}
                    </Link>
                    <Button variant="secondary" onClick={() => setConfirming(true)}>
                        {tc.remove}
                    </Button>
                </div>
            )}
            {confirming && (
                <div
                    role="group"
                    aria-label={tc.confirmDeleteAppointment(appointment.title)}
                    className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4"
                >
                    <p className="font-bold">{tc.confirmDeleteAppointment(appointment.title)}</p>
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
        </div>
    );
}

function Questions({ appointment, canWrite }: { appointment: Appointment; canWrite: boolean }) {
    const queryClient = useQueryClient();
    const questions = useQuestions(appointment.id, true);
    const [question, setQuestion] = useState('');
    const [error, setError] = useState<string | null>(null);
    const refresh = () => queryClient.invalidateQueries({ queryKey: coordKeys.questions(appointment.id) });
    const list = questions.data ?? [];

    async function add(event: FormEvent) {
        event.preventDefault();
        if (!question.trim()) return;
        try {
            await addQuestion(appointment.care_file_id, appointment.id, question, list.length);
            setQuestion('');
            setError(null);
            await refresh();
        } catch {
            setError(fr.app.genericError);
        }
    }

    return (
        <section aria-labelledby="questions-title" className="flex flex-col gap-3">
            <h2 id="questions-title" className="text-2xl font-bold">
                {tc.questionsTitle}
            </h2>
            <p>{tc.questionsIntro}</p>
            {list.length === 0 && <p className="text-muted">{tc.noQuestions}</p>}
            <ol className="flex list-decimal flex-col gap-2 pl-6">
                {list.map((q) => (
                    <li key={q.id}>
                        <span>{q.question}</span>
                        {canWrite && (
                            <Button
                                variant="quiet"
                                className="ml-1 px-1"
                                aria-label={tc.removeQuestion(q.question)}
                                onClick={() => void deleteQuestion(q.id).then(refresh)}
                            >
                                {tc.removeShort}
                            </Button>
                        )}
                    </li>
                ))}
            </ol>
            {canWrite && (
                <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2">
                    <FreeTextField compact label={tc.questionLabel} value={question} maxLength={500} onValueChange={setQuestion} />
                    <Button type="submit" variant="secondary" className="self-start">
                        {tc.addQuestion}
                    </Button>
                </form>
            )}
            {error && <Notice tone="error">{error}</Notice>}
        </section>
    );
}
