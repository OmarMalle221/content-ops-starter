import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Card, Loading, Notice, PageTitle, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { documents as td } from '../../i18n/documents.fr';
import { createTimelineEvent, deleteMedication, deleteTimelineEvent, type TimelineEvent } from '../../lib/documents';
import { formatDate } from '../../lib/format';
import { TIMELINE_EVENT_LABELS } from '../../shared/extraction/labels.fr';
import { TIMELINE_EVENT_TYPES, type TimelineEventType } from '../../shared/extraction/schema';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from '../files/FileLayout';
import { HealthQuestionNotice } from './HealthQuestionNotice';
import { docKeys, useMedications, useTimeline } from './useDocuments';

type Status = { tone: 'success' | 'error'; text: string } | null;

/** Chronologie (chaque événement relié à sa source) et médicaments tels qu'écrits dans les documents. */
export function TimelinePage() {
    const { file, access } = useFileContext();
    const timeline = useTimeline(file.id);
    const medications = useMedications(file.id);
    const canWrite = access.canWrite('health');
    const [status, setStatus] = useState<Status>(null);
    const [adding, setAdding] = useState(false);

    if (timeline.isPending || medications.isPending) return <Loading />;
    const events = timeline.data ?? [];
    const meds = medications.data ?? [];

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{td.timelineTitle}</PageTitle>
            <p>{td.timelineIntro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}

            {events.length === 0 && <p className="text-muted">{td.noEvents}</p>}
            <ol className="flex list-none flex-col gap-3 p-0">
                {events.map((event) => (
                    <li key={event.id}>
                        <EventCard event={event} canWrite={canWrite} onStatus={setStatus} />
                    </li>
                ))}
            </ol>

            {canWrite &&
                (adding ? (
                    <EventForm
                        fileId={file.id}
                        onDone={(s) => {
                            setAdding(false);
                            setStatus(s);
                        }}
                    />
                ) : (
                    <Button variant="secondary" className="self-start" onClick={() => setAdding(true)}>
                        {td.addManualEvent}
                    </Button>
                ))}

            <section aria-labelledby="medications-title" className="flex flex-col gap-3">
                <h2 id="medications-title" className="text-2xl font-bold">
                    {td.medicationsTitle}
                </h2>
                <p>{td.medicationsIntro}</p>
                <HealthQuestionNotice short />
                {meds.length === 0 && <p className="text-muted">{td.noMedications}</p>}
                <ul className="flex list-none flex-col gap-3 p-0">
                    {meds.map((m) => (
                        <li key={m.id}>
                            <Card className="flex flex-col gap-1">
                                <p className="text-lg font-bold">{m.name_as_written}</p>
                                {(m.dosage_as_written || m.frequency_as_written) && (
                                    <p>{[m.dosage_as_written, m.frequency_as_written].filter(Boolean).join(' — ')}</p>
                                )}
                                <p className="text-muted">{m.document_date ? td.mentionedOn(formatDate(m.document_date)) : ''}</p>
                                <div className="flex flex-wrap gap-3">
                                    <Link
                                        to={`../documents/${m.source_document_id}`}
                                        relative="path"
                                        className="font-bold text-brand underline underline-offset-4"
                                    >
                                        {td.fromDocument}
                                    </Link>
                                    {canWrite && <RemoveMedication id={m.id} fileId={file.id} onStatus={setStatus} />}
                                </div>
                            </Card>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}

function EventCard({ event, canWrite, onStatus }: { event: TimelineEvent; canWrite: boolean; onStatus: (s: Status) => void }) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);

    async function remove() {
        try {
            await deleteTimelineEvent(event.id);
            await queryClient.invalidateQueries({ queryKey: docKeys.timeline(event.care_file_id) });
            onStatus({ tone: 'success', text: td.eventDeleted });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <Card className="flex flex-col gap-1">
            <p className="text-muted">
                <time dateTime={event.occurred_on}>{formatDate(event.occurred_on)}</time> · {TIMELINE_EVENT_LABELS[event.event_type]}
            </p>
            <h2 className="text-lg font-bold">{event.title}</h2>
            {event.description && <p>{event.description}</p>}
            <div className="flex flex-wrap items-center gap-3">
                {event.source_document_id ? (
                    <Link
                        to={`../documents/${event.source_document_id}`}
                        relative="path"
                        className="font-bold text-brand underline underline-offset-4"
                    >
                        {td.fromDocument}
                    </Link>
                ) : (
                    <span className="text-muted">{td.addedManually}</span>
                )}
                {canWrite && !confirming && (
                    <Button variant="quiet" onClick={() => setConfirming(true)}>
                        {td.deleteEvent}
                    </Button>
                )}
            </div>
            {confirming && (
                <div
                    role="group"
                    aria-label={td.confirmDeleteEvent(event.title)}
                    className="mt-2 flex flex-col gap-2 rounded-lg bg-urgent-soft p-3"
                >
                    <p className="font-bold">{td.confirmDeleteEvent(event.title)}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="danger" onClick={() => void remove()}>
                            {td.deleteEvent}
                        </Button>
                        <Button variant="secondary" onClick={() => setConfirming(false)}>
                            {td.cancel}
                        </Button>
                    </div>
                </div>
            )}
        </Card>
    );
}

function EventForm({ fileId, onDone }: { fileId: string; onDone: (s: Status) => void }) {
    const queryClient = useQueryClient();
    const [date, setDate] = useState('');
    const [eventType, setEventType] = useState<TimelineEventType>('other');
    const [title, setTitle] = useState('');
    const [details, setDetails] = useState('');
    const [errors, setErrors] = useState<{ date?: string; title?: string; form?: string }>({});
    const [busy, setBusy] = useState(false);

    async function submit(e: FormEvent) {
        e.preventDefault();
        const next = {
            date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? undefined : td.eventDateRequired,
            title: title.trim() ? undefined : td.eventTitleRequired
        };
        setErrors(next);
        if (next.date || next.title) return;
        setBusy(true);
        try {
            await createTimelineEvent(fileId, { event_type: eventType, occurred_on: date, title, description: details || null });
            await queryClient.invalidateQueries({ queryKey: docKeys.timeline(fileId) });
            onDone({ tone: 'success', text: td.eventSaved });
        } catch {
            setErrors({ form: fr.app.genericError });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            onSubmit={submit}
            noValidate
            aria-labelledby="add-event"
            className="flex flex-col gap-4 rounded-xl border-2 border-line bg-surface p-4"
        >
            <h2 id="add-event" className="text-xl font-bold">
                {td.addManualEvent}
            </h2>
            <TextField label={td.eventDate} type="date" value={date} error={errors.date} onChange={(e) => setDate(e.target.value)} />
            <SelectField
                label={td.eventType}
                value={eventType}
                onChange={(e) => setEventType(e.target.value as TimelineEventType)}
                options={TIMELINE_EVENT_TYPES.map((t) => ({ value: t, label: TIMELINE_EVENT_LABELS[t] }))}
            />
            <FreeTextField compact label={td.eventTitle} value={title} maxLength={160} onValueChange={setTitle} />
            {errors.title && <p className="font-bold text-urgent">{errors.title}</p>}
            <FreeTextField compact label={td.eventDetails} value={details} maxLength={2000} onValueChange={setDetails} />
            {errors.form && <Notice tone="error">{errors.form}</Notice>}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                    {td.saveEvent}
                </Button>
                <Button variant="secondary" onClick={() => onDone(null)}>
                    {td.cancel}
                </Button>
            </div>
        </form>
    );
}

function RemoveMedication({ id, fileId, onStatus }: { id: string; fileId: string; onStatus: (s: Status) => void }) {
    const queryClient = useQueryClient();
    async function remove() {
        try {
            await deleteMedication(id);
            await queryClient.invalidateQueries({ queryKey: docKeys.medications(fileId) });
            onStatus({ tone: 'success', text: td.medicationDeleted });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }
    return (
        <Button variant="quiet" onClick={() => void remove()}>
            {td.deleteMedication}
        </Button>
    );
}
