import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Checkbox, Notice, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { documents as td } from '../../i18n/documents.fr';
import { ApiError } from '../../lib/api';
import { confirmDocument, discardExtraction, type CareDocument, type Extraction } from '../../lib/documents';
import { DOCUMENT_TYPE_LABELS, GUARD_FLAG_LABELS, REVIEW_REASON_LABELS, TIMELINE_EVENT_LABELS } from '../../shared/extraction/labels.fr';
import {
    DOCUMENT_TYPES,
    TIMELINE_EVENT_TYPES,
    type ConfirmationInput,
    type DocumentType,
    type ExtractionDraft,
    type TimelineEventType
} from '../../shared/extraction/schema';
import { FreeTextField } from '../distress/FreeTextField';
import { fileKeys } from '../files/useFile';
import { docKeys } from './useDocuments';
import { HealthQuestionNotice } from './HealthQuestionNotice';

interface Item {
    key: string;
    keep: boolean;
    sourceLine: string | null;
    unverified: boolean;
}
interface MedicationItem extends Item {
    name: string;
    dosage: string;
    frequency: string;
}
interface EventItem extends Item {
    date: string;
    eventType: TimelineEventType;
    title: string;
    details: string;
}
interface ActionItem extends Item {
    text: string;
}

let nextKey = 0;
const key = () => `item-${++nextKey}`;

function initialEvents(draft: ExtractionDraft | null): EventItem[] {
    if (!draft) return [];
    return [
        ...draft.timeline_events.map((e) => ({
            key: key(),
            keep: !e.unverified && e.date !== null,
            sourceLine: e.source_line,
            unverified: e.unverified,
            date: e.date ?? '',
            eventType: e.event_type,
            title: e.title,
            details: ''
        })),
        ...draft.appointments.map((a) => ({
            key: key(),
            keep: !a.unverified && a.date !== null,
            sourceLine: a.source_line,
            unverified: a.unverified,
            date: a.date ?? '',
            eventType: 'appointment' as const,
            title: a.purpose,
            details: [a.time, a.place].filter(Boolean).join(', ')
        }))
    ];
}

/**
 * Relecture d'un brouillon (lecture automatique) ou saisie à la main : chaque élément se garde, se
 * corrige ou se décoche. Rien n'entre au dossier avant « Confirmer ».
 */
export function ReviewForm({
    document,
    extraction,
    onDone
}: {
    document: CareDocument;
    extraction: Extraction | null;
    onDone: (message: string) => void;
}) {
    const queryClient = useQueryClient();
    const draft = extraction?.draft ?? null;
    const manual = draft === null;
    const errorRef = useRef<HTMLDivElement>(null);

    const [title, setTitle] = useState(draft?.title ?? '');
    const [docType, setDocType] = useState<DocumentType>(draft?.document_type ?? 'other');
    const [docDate, setDocDate] = useState(draft?.document_date ?? '');
    const [author, setAuthor] = useState(draft?.author ?? '');
    const [needsReview, setNeedsReview] = useState(draft?.needs_review ?? document.mime_type !== 'application/pdf');
    const [summary, setSummary] = useState(draft?.plain_summary ?? '');
    const [medications, setMedications] = useState<MedicationItem[]>(
        () =>
            draft?.medications.map((m) => ({
                key: key(),
                keep: !m.unverified,
                sourceLine: m.source_line,
                unverified: m.unverified,
                name: m.name,
                dosage: m.dosage ?? '',
                frequency: m.frequency ?? ''
            })) ?? []
    );
    const [events, setEvents] = useState<EventItem[]>(() => initialEvents(draft));
    const [actions, setActions] = useState<ActionItem[]>(
        () =>
            draft?.action_items.map((a) => ({
                key: key(),
                keep: !a.unverified,
                sourceLine: a.source_line,
                unverified: a.unverified,
                text: a.text
            })) ?? []
    );
    const [errors, setErrors] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const update = <T extends Item>(setter: (fn: (items: T[]) => T[]) => void, itemKey: string, patch: Partial<T>) =>
        setter((items) => items.map((item) => (item.key === itemKey ? { ...item, ...patch } : item)));

    function validate(): string[] {
        const problems: string[] = [];
        medications.forEach((m, i) => m.keep && m.name.trim() === '' && problems.push(td.errorMedName(i + 1)));
        events.forEach((e, i) => {
            if (!e.keep) return;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) problems.push(td.errorEventDate(i + 1));
            if (e.title.trim() === '') problems.push(td.errorEventTitle(i + 1));
        });
        actions.forEach((a, i) => a.keep && a.text.trim() === '' && problems.push(td.errorAction(i + 1)));
        return problems;
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        const problems = validate();
        setErrors(problems);
        if (problems.length > 0) {
            requestAnimationFrame(() => errorRef.current?.focus());
            return;
        }
        const confirmation: ConfirmationInput = {
            document: { title, doc_type: docType, doc_date: docDate || null, author, needs_review: needsReview },
            summary,
            medications: medications.filter((m) => m.keep).map((m) => ({ name: m.name, dosage: m.dosage, frequency: m.frequency })),
            timeline_events: events
                .filter((e) => e.keep)
                .map((e) => ({ event_type: e.eventType, occurred_on: e.date, title: e.title, description: e.details })),
            action_items: actions.filter((a) => a.keep).map((a) => ({ text: a.text }))
        };
        setBusy(true);
        try {
            await confirmDocument(document.id, manual ? null : (extraction?.id ?? null), confirmation);
            await refresh();
            onDone(td.confirmed);
        } catch (error) {
            if (error instanceof ApiError && error.code === 'RLA02') {
                await refresh();
                onDone(td.errorStale);
            } else {
                setErrors([fr.app.genericError]);
                requestAnimationFrame(() => errorRef.current?.focus());
            }
        } finally {
            setBusy(false);
        }
    }

    async function refresh() {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: docKeys.document(document.id) }),
            queryClient.invalidateQueries({ queryKey: docKeys.list(document.care_file_id) }),
            queryClient.invalidateQueries({ queryKey: docKeys.timeline(document.care_file_id) }),
            queryClient.invalidateQueries({ queryKey: docKeys.medications(document.care_file_id) }),
            queryClient.invalidateQueries({ queryKey: fileKeys.log(document.care_file_id) })
        ]);
    }

    async function discard() {
        if (!extraction) return;
        setBusy(true);
        try {
            await discardExtraction(extraction.id);
            await refresh();
            onDone(td.discarded);
        } catch {
            setErrors([fr.app.genericError]);
        } finally {
            setBusy(false);
        }
    }

    const reasons = draft?.review_reasons ?? [];
    const flags = draft?.guard_flags ?? [];

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-5" aria-labelledby="review-title">
            <h2 id="review-title" className="text-2xl font-bold">
                {manual ? td.manualTitle : td.reviewTitle}
            </h2>
            <p>{manual ? td.manualIntro : td.reviewIntro}</p>
            <HealthQuestionNotice />

            {(reasons.length > 0 || flags.length > 0) && (
                <section aria-labelledby="review-reasons" className="rounded-lg bg-urgent-soft p-4">
                    <h3 id="review-reasons" className="text-lg font-bold">
                        {td.reasonsTitle}
                    </h3>
                    <ul className="mt-2 list-disc pl-5">
                        {reasons.map((r) => (
                            <li key={r}>{REVIEW_REASON_LABELS[r]}</li>
                        ))}
                        {flags.map((f) => (
                            <li key={f}>{GUARD_FLAG_LABELS[f]}</li>
                        ))}
                    </ul>
                </section>
            )}

            <fieldset className="flex flex-col gap-4">
                <legend className="mb-2 text-xl font-bold">{td.documentSection}</legend>
                <TextField label={td.docTitle} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
                <SelectField
                    label={td.docType}
                    value={docType}
                    onChange={(e) => setDocType(e.target.value as DocumentType)}
                    options={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] }))}
                />
                <TextField label={td.docDate} type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
                <TextField label={td.docAuthor} value={author} maxLength={160} onChange={(e) => setAuthor(e.target.value)} />
                <FreeTextField
                    label={td.summary}
                    hint={manual ? td.summaryManualHint : td.summaryHint}
                    value={summary}
                    maxLength={1200}
                    onValueChange={setSummary}
                />
                <Checkbox label={td.markToCheck} checked={needsReview} onChange={(e) => setNeedsReview(e.target.checked)} />
            </fieldset>

            <section aria-labelledby="review-medications" className="flex flex-col gap-3">
                <h3 id="review-medications" className="text-xl font-bold">
                    {td.medicationsSection}
                </h3>
                <p className="text-muted">{td.medicationsHint}</p>
                {medications.map((m, i) => (
                    <ItemFieldset
                        key={m.key}
                        legend={td.medication(i + 1, m.name)}
                        item={m}
                        onKeep={(keep) => update(setMedications, m.key, { keep })}
                    >
                        <TextField
                            label={td.medName}
                            value={m.name}
                            maxLength={160}
                            onChange={(e) => update(setMedications, m.key, { name: e.target.value })}
                        />
                        <TextField
                            label={td.medDosage}
                            value={m.dosage}
                            maxLength={160}
                            onChange={(e) => update(setMedications, m.key, { dosage: e.target.value })}
                        />
                        <TextField
                            label={td.medFrequency}
                            value={m.frequency}
                            maxLength={160}
                            onChange={(e) => update(setMedications, m.key, { frequency: e.target.value })}
                        />
                    </ItemFieldset>
                ))}
                <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() =>
                        setMedications((items) => [
                            ...items,
                            { key: key(), keep: true, sourceLine: null, unverified: false, name: '', dosage: '', frequency: '' }
                        ])
                    }
                >
                    {td.addMedication}
                </Button>
            </section>

            <section aria-labelledby="review-events" className="flex flex-col gap-3">
                <h3 id="review-events" className="text-xl font-bold">
                    {td.eventsSection}
                </h3>
                <p className="text-muted">{td.eventsHint}</p>
                {events.map((e, i) => (
                    <ItemFieldset
                        key={e.key}
                        legend={td.event(i + 1, e.title)}
                        item={e}
                        onKeep={(keep) => update(setEvents, e.key, { keep })}
                    >
                        <TextField
                            label={td.eventDate}
                            type="date"
                            value={e.date}
                            onChange={(ev) => update(setEvents, e.key, { date: ev.target.value })}
                        />
                        <SelectField
                            label={td.eventType}
                            value={e.eventType}
                            onChange={(ev) => update(setEvents, e.key, { eventType: ev.target.value as TimelineEventType })}
                            options={TIMELINE_EVENT_TYPES.map((t) => ({ value: t, label: TIMELINE_EVENT_LABELS[t] }))}
                        />
                        <FreeTextField
                            compact
                            label={td.eventTitle}
                            value={e.title}
                            maxLength={160}
                            onValueChange={(v) => update(setEvents, e.key, { title: v })}
                        />
                        <FreeTextField
                            compact
                            label={td.eventDetails}
                            value={e.details}
                            maxLength={2000}
                            onValueChange={(v) => update(setEvents, e.key, { details: v })}
                        />
                    </ItemFieldset>
                ))}
                <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() =>
                        setEvents((items) => [
                            ...items,
                            {
                                key: key(),
                                keep: true,
                                sourceLine: null,
                                unverified: false,
                                date: docDate,
                                eventType: 'other',
                                title: '',
                                details: ''
                            }
                        ])
                    }
                >
                    {td.addEvent}
                </Button>
            </section>

            <section aria-labelledby="review-actions" className="flex flex-col gap-3">
                <h3 id="review-actions" className="text-xl font-bold">
                    {td.actionsSection}
                </h3>
                <p className="text-muted">{td.actionsHint}</p>
                {actions.map((a, i) => (
                    <ItemFieldset key={a.key} legend={td.action(i + 1)} item={a} onKeep={(keep) => update(setActions, a.key, { keep })}>
                        <FreeTextField
                            compact
                            label={td.actionText}
                            value={a.text}
                            maxLength={240}
                            onValueChange={(v) => update(setActions, a.key, { text: v })}
                        />
                    </ItemFieldset>
                ))}
                <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() =>
                        setActions((items) => [...items, { key: key(), keep: true, sourceLine: null, unverified: false, text: '' }])
                    }
                >
                    {td.addAction}
                </Button>
            </section>

            {errors.length > 0 && (
                <div ref={errorRef} tabIndex={-1} className="outline-none">
                    <Notice tone="error">
                        <ul className="list-disc pl-5">
                            {errors.map((error) => (
                                <li key={error}>{error}</li>
                            ))}
                        </ul>
                    </Notice>
                </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row">
                <Button type="submit" disabled={busy}>
                    {busy ? td.confirming : td.confirm}
                </Button>
                {!manual && (
                    <Button variant="secondary" disabled={busy} onClick={() => void discard()}>
                        {td.discard}
                    </Button>
                )}
            </div>
        </form>
    );
}

function ItemFieldset({
    legend,
    item,
    onKeep,
    children
}: {
    legend: string;
    item: Item;
    onKeep: (keep: boolean) => void;
    children: React.ReactNode;
}) {
    return (
        <fieldset className={`flex flex-col gap-3 rounded-xl border-2 p-4 ${item.unverified ? 'border-urgent' : 'border-line'} bg-surface`}>
            <legend className="px-1 font-bold">{legend}</legend>
            {item.unverified && <p className="font-bold text-urgent">{td.unverified}</p>}
            {item.sourceLine && <p className="text-muted">{td.sourceLine(item.sourceLine)}</p>}
            <Checkbox label={td.keep} checked={item.keep} onChange={(e) => onKeep(e.target.checked)} />
            {item.keep && children}
        </fieldset>
    );
}
