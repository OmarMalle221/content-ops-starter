import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useProfile } from '../../app/queries';
import { Button, Card, Checkbox, Loading, Notice, PageTitle, RadioGroup, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { benefits as tb, PROGRAM_STATUS_LABELS } from '../../i18n/benefits.fr';
import {
    addChecklistItem,
    deleteChecklistItem,
    draftLetter,
    explainProgram,
    PROGRAM_STATUSES,
    setChecklistItemDone,
    updateFileProgram,
    type ChecklistItem,
    type FileProgram,
    type Program,
    type ProgramStatus
} from '../../lib/benefits';
import { formatDate } from '../../lib/format';
import { fillPlaceholders, LETTER_KINDS, type ExplanationOutput, type LetterKind } from '../../shared/benefits/ai';
import { assess, criteriaLabels, factsFromAnswers } from '../../shared/benefits/engine';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from '../files/FileLayout';
import { useCareRecipient } from '../files/useFile';
import { CriteriaReasons, ProgramSource } from './ProgramCard';
import { benefitKeys, useBenefitAnswers, useFilePrograms, usePrograms } from './useBenefits';

type Status = { tone: 'success' | 'error'; text: string } | null;

export function ProgramPage() {
    const { programSlug = '' } = useParams();
    const { file, access } = useFileContext();
    const programs = usePrograms();
    const answers = useBenefitAnswers(file.id);
    const filePrograms = useFilePrograms(file.id);
    const canWrite = access.canWrite('benefits');
    const [status, setStatus] = useState<Status>(null);

    if (programs.isPending || answers.isPending || filePrograms.isPending) return <Loading />;
    const program = programs.data?.find((p) => p.slug === programSlug && p.is_active);
    if (!program) {
        return (
            <div className="flex flex-col gap-4">
                <Notice tone="error">{tb.programNotFound}</Notice>
                <Link to=".." relative="path" className="font-bold text-brand underline underline-offset-4">
                    {tb.backToList}
                </Link>
            </div>
        );
    }
    const fileProgram = filePrograms.data?.find((fp) => fp.program_id === program.id);
    const assessment = answers.data ? assess(program.criteria, factsFromAnswers(answers.data.answers)) : null;

    return (
        <div className="flex flex-col gap-5">
            <Link to=".." relative="path" className="self-start font-bold text-brand underline underline-offset-4">
                {tb.backToList}
            </Link>
            <PageTitle>{program.name}</PageTitle>
            <p className="text-muted">{program.organization}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <p>{program.summary}</p>
            <ProgramSource program={program} />

            <section aria-labelledby="criteria-title" className="flex flex-col gap-2">
                <h2 id="criteria-title" className="text-xl font-bold">
                    {tb.criteriaTitle}
                </h2>
                {assessment ? (
                    <CriteriaReasons assessment={assessment} />
                ) : (
                    <ul className="list-disc pl-5">
                        {criteriaLabels(program.criteria).map((label) => (
                            <li key={label}>{label}</li>
                        ))}
                    </ul>
                )}
            </section>

            {program.how_to_apply && (
                <section aria-labelledby="apply-title" className="flex flex-col gap-2">
                    <h2 id="apply-title" className="text-xl font-bold">
                        {tb.howToApplyTitle}
                    </h2>
                    <p>{program.how_to_apply}</p>
                </section>
            )}

            {fileProgram ? (
                <>
                    <StatusSection fileProgram={fileProgram} canWrite={canWrite} onStatus={setStatus} />
                    <Checklist fileProgram={fileProgram} canWrite={canWrite} />
                    <Notes fileProgram={fileProgram} canWrite={canWrite} onStatus={setStatus} />
                </>
            ) : (
                <>
                    <Notice tone="info">{tb.notInFile}</Notice>
                    <StaticDocuments program={program} />
                </>
            )}

            <Explanation program={program} />
            {fileProgram && canWrite && <Letter program={program} fileProgram={fileProgram} onStatus={setStatus} />}
        </div>
    );
}

function StaticDocuments({ program }: { program: Program }) {
    return (
        <section aria-labelledby="documents-title" className="flex flex-col gap-2">
            <h2 id="documents-title" className="text-xl font-bold">
                {tb.documentsTitle}
            </h2>
            {program.required_documents.length === 0 ? (
                <p className="text-muted">{tb.noDocuments}</p>
            ) : (
                <ul className="list-disc pl-5">
                    {program.required_documents.map((d) => (
                        <li key={d}>{d}</li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function StatusSection({
    fileProgram,
    canWrite,
    onStatus
}: {
    fileProgram: FileProgram;
    canWrite: boolean;
    onStatus: (s: Status) => void;
}) {
    const queryClient = useQueryClient();
    // Affiché tout de suite ; rétabli si l'enregistrement échoue.
    const [value, setValue] = useState<ProgramStatus>(fileProgram.status);
    async function change(next: ProgramStatus) {
        const previous = value;
        setValue(next);
        try {
            await updateFileProgram(fileProgram.id, { status: next });
            await queryClient.invalidateQueries({ queryKey: benefitKeys.filePrograms(fileProgram.care_file_id) });
            onStatus({ tone: 'success', text: tb.statusSaved });
        } catch {
            setValue(previous);
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }
    if (!canWrite) {
        return (
            <p>
                <span className="font-bold">{tb.statusTitle}</span> {PROGRAM_STATUS_LABELS[fileProgram.status]}
            </p>
        );
    }
    return (
        <RadioGroup
            legend={tb.statusTitle}
            name="program-status"
            value={value}
            options={PROGRAM_STATUSES.map((s) => ({ value: s, label: PROGRAM_STATUS_LABELS[s] ?? s }))}
            onChange={(value) => void change(value)}
        />
    );
}

function Checklist({ fileProgram, canWrite }: { fileProgram: FileProgram; canWrite: boolean }) {
    const queryClient = useQueryClient();
    const [label, setLabel] = useState('');
    const refresh = () => queryClient.invalidateQueries({ queryKey: benefitKeys.filePrograms(fileProgram.care_file_id) });

    async function add(event: FormEvent) {
        event.preventDefault();
        if (!label.trim()) return;
        await addChecklistItem(fileProgram.care_file_id, fileProgram.id, label, fileProgram.checklist.length);
        setLabel('');
        await refresh();
    }

    return (
        <section aria-labelledby="documents-title" className="flex flex-col gap-2">
            <h2 id="documents-title" className="text-xl font-bold">
                {tb.documentsTitle}
            </h2>
            {fileProgram.checklist.length === 0 && <p className="text-muted">{tb.noDocuments}</p>}
            <ul className="flex list-none flex-col gap-1 p-0">
                {fileProgram.checklist.map((item) => (
                    <ChecklistRow key={item.id} item={item} canWrite={canWrite} onChanged={refresh} />
                ))}
            </ul>
            {canWrite && (
                <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <div className="grow">
                        <TextField label={tb.addDocumentLabel} value={label} maxLength={240} onChange={(e) => setLabel(e.target.value)} />
                    </div>
                    <Button type="submit" variant="secondary">
                        {tb.add}
                    </Button>
                </form>
            )}
        </section>
    );
}

function ChecklistRow({ item, canWrite, onChanged }: { item: ChecklistItem; canWrite: boolean; onChanged: () => Promise<void> }) {
    // Cochée tout de suite ; rétablie si l'enregistrement échoue.
    const [done, setDone] = useState(item.is_done);
    async function toggle(next: boolean) {
        setDone(next);
        try {
            await setChecklistItemDone(item.id, next);
            await onChanged();
        } catch {
            setDone(!next);
        }
    }
    return (
        <li className="flex flex-wrap items-center gap-2">
            {canWrite ? (
                <Checkbox label={item.label} checked={done} onChange={(e) => void toggle(e.target.checked)} />
            ) : (
                <span>
                    {item.is_done ? '✓ ' : ''}
                    {item.label}
                </span>
            )}
            {canWrite && item.origin === 'custom' && (
                <Button variant="quiet" onClick={() => void deleteChecklistItem(item.id).then(onChanged)}>
                    {tb.removeDocument(item.label)}
                </Button>
            )}
        </li>
    );
}

function Notes({ fileProgram, canWrite, onStatus }: { fileProgram: FileProgram; canWrite: boolean; onStatus: (s: Status) => void }) {
    const queryClient = useQueryClient();
    const [notes, setNotes] = useState(fileProgram.notes ?? '');
    if (!canWrite) return fileProgram.notes ? <Card>{fileProgram.notes}</Card> : null;
    async function save() {
        try {
            await updateFileProgram(fileProgram.id, { notes: notes.trim() || null });
            await queryClient.invalidateQueries({ queryKey: benefitKeys.filePrograms(fileProgram.care_file_id) });
            onStatus({ tone: 'success', text: tb.notesSaved });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }
    return (
        <div className="flex flex-col gap-2">
            <FreeTextField label={tb.notesLabel} value={notes} maxLength={2000} onValueChange={setNotes} />
            <Button variant="secondary" className="self-start" onClick={() => void save()}>
                {tb.saveNotes}
            </Button>
        </div>
    );
}

function Explanation({ program }: { program: Program }) {
    const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'done'; explanation: ExplanationOutput | null }>({
        phase: 'idle',
        explanation: null
    });
    async function load() {
        setState({ phase: 'loading', explanation: null });
        const explanation = await explainProgram(program.id).catch(() => null);
        setState({ phase: 'done', explanation });
    }
    return (
        <section aria-labelledby="explain-title" className="flex flex-col gap-3">
            <h2 id="explain-title" className="text-xl font-bold">
                {tb.explainTitle}
            </h2>
            {state.phase === 'idle' && (
                <Button variant="secondary" className="self-start" onClick={() => void load()}>
                    {tb.explain}
                </Button>
            )}
            {state.phase === 'loading' && <p role="status">{tb.explaining}</p>}
            {state.phase === 'done' && state.explanation && (
                <div className="flex flex-col gap-3 rounded-lg border-2 border-line bg-surface p-4" role="status">
                    <p>{state.explanation.plain_explanation}</p>
                    <ExplanationList title={tb.whoItMayHelp} items={state.explanation.who_it_may_help} />
                    <ExplanationList title={tb.steps} items={state.explanation.steps} />
                    <ExplanationList title={tb.notInFiche} items={state.explanation.not_in_fiche} />
                    <p className="text-muted">{tb.explainedFromFiche}</p>
                </div>
            )}
            {state.phase === 'done' && !state.explanation && (
                <Notice tone="info">
                    <p>{tb.dontKnow}</p>
                </Notice>
            )}
        </section>
    );
}

function ExplanationList({ title, items }: { title: string; items: string[] }) {
    if (items.length === 0) return null;
    return (
        <div>
            <h3 className="font-bold">{title}</h3>
            <ul className="list-disc pl-5">
                {items.map((item) => (
                    <li key={item}>{item}</li>
                ))}
            </ul>
        </div>
    );
}

function Letter({ program, fileProgram, onStatus }: { program: Program; fileProgram: FileProgram; onStatus: (s: Status) => void }) {
    const queryClient = useQueryClient();
    const profile = useProfile();
    const recipient = useCareRecipient(fileProgram.care_file_id);
    const [kind, setKind] = useState<LetterKind>('information_request');
    const [letter, setLetter] = useState(fileProgram.letter_draft ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function prepare() {
        setBusy(true);
        setError(null);
        const template = await draftLetter(program.id, kind).catch(() => null);
        setBusy(false);
        if (!template) return setError(tb.letterUnavailable);
        // Les noms sont ajoutés ici, sur le téléphone : ils ne sont jamais envoyés au fournisseur d'IA.
        const recipientName = [recipient.data?.first_name, recipient.data?.last_name].filter(Boolean).join(' ');
        setLetter(
            fillPlaceholders(template, {
                '[NOM DE LA PERSONNE AIDÉE]': recipientName,
                '[VOTRE NOM]': profile.data?.display_name ?? '',
                '[DATE]': formatDate(new Date().toISOString())
            })
        );
    }

    async function save() {
        try {
            await updateFileProgram(fileProgram.id, { letter_draft: letter.trim() || null });
            await queryClient.invalidateQueries({ queryKey: benefitKeys.filePrograms(fileProgram.care_file_id) });
            onStatus({ tone: 'success', text: tb.letterSaved });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <section aria-labelledby="letter-title" className="flex flex-col gap-3">
            <h2 id="letter-title" className="text-xl font-bold">
                {tb.letterTitle}
            </h2>
            <p>{tb.letterIntro}</p>
            <SelectField
                label={tb.letterKind}
                value={kind}
                onChange={(e) => setKind(e.target.value as LetterKind)}
                options={LETTER_KINDS.map((k) => ({ value: k, label: tb.letterKinds[k] ?? k }))}
            />
            <Button variant="secondary" className="self-start" disabled={busy} onClick={() => void prepare()}>
                {busy ? tb.preparingLetter : tb.prepareLetter}
            </Button>
            {error && <Notice tone="error">{error}</Notice>}
            {letter && (
                <>
                    <FreeTextField label={tb.letterLabel} value={letter} maxLength={8000} onValueChange={setLetter} rows={14} />
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void save()}>{tb.saveLetter}</Button>
                        <Button
                            variant="secondary"
                            onClick={() =>
                                void navigator.clipboard?.writeText(letter).then(
                                    () => onStatus({ tone: 'success', text: tb.copied }),
                                    () => undefined
                                )
                            }
                        >
                            {tb.copyLetter}
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}
