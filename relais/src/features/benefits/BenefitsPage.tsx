import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, Loading, Notice, PageTitle, RadioGroup, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { benefits as tb, QUESTIONS } from '../../i18n/benefits.fr';
import { LIVING_SETTING_LABELS } from '../../i18n/files.fr';
import { saveAssessment, type FileProgram, type Program } from '../../lib/benefits';
import type { CareNeeds, CareRecipient } from '../../lib/careFiles';
import { formatDate } from '../../lib/format';
import {
    assessPrograms,
    factsFromAnswers,
    LIVING_SETTINGS,
    QUESTION_FACTS,
    type BenefitAnswers,
    type LivingSetting,
    type TriState
} from '../../shared/benefits/engine';
import { useFileContext } from '../files/FileLayout';
import { useCareNeeds, useCareRecipient } from '../files/useFile';
import { ProgramCard } from './ProgramCard';
import { benefitKeys, useBenefitAnswers, useFilePrograms, usePrograms } from './useBenefits';

/** Navigateur de droits : questionnaire, puis liste personnalisée (moteur de règles, sans IA). */
export function BenefitsPage() {
    const { file, access } = useFileContext();
    const programs = usePrograms();
    const answers = useBenefitAnswers(file.id);
    const filePrograms = useFilePrograms(file.id);
    const recipient = useCareRecipient(file.id);
    const needs = useCareNeeds(file.id, access.canRead('health'));
    const canWrite = access.canWrite('benefits');
    const [editing, setEditing] = useState(false);

    if (programs.isPending || answers.isPending || filePrograms.isPending || recipient.isPending) return <Loading />;
    const current = answers.data ?? null;
    const showForm = canWrite && (editing || !current);

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tb.title}</PageTitle>
            <p>{tb.intro}</p>
            <p className="text-muted">{tb.howItWorks}</p>
            {!canWrite && <p className="text-muted">{current ? tb.readOnly : tb.notFilled}</p>}

            {showForm ? (
                <Questionnaire
                    fileId={file.id}
                    programs={programs.data ?? []}
                    initial={current?.answers ?? prefill(recipient.data ?? null, needs.data ?? null)}
                    onDone={() => setEditing(false)}
                    onCancel={current ? () => setEditing(false) : undefined}
                />
            ) : (
                current && (
                    <>
                        <div className="flex flex-wrap items-center gap-3">
                            <p className="text-muted">{tb.answeredOn(formatDate(current.created_at))}</p>
                            {canWrite && (
                                <Button variant="secondary" onClick={() => setEditing(true)}>
                                    {tb.redo}
                                </Button>
                            )}
                        </div>
                        <Results programs={programs.data ?? []} answers={current.answers} filePrograms={filePrograms.data ?? []} />
                    </>
                )
            )}
        </div>
    );
}

/** Réponses de départ tirées du profil : âge, milieu de vie, aide domestique, adaptation du logement. */
function prefill(recipient: CareRecipient | null, needs: CareNeeds | null): BenefitAnswers {
    const age = recipient?.birth_year ? new Date().getFullYear() - recipient.birth_year : null;
    return {
        recipient_age: age !== null && age >= 18 && age <= 120 ? age : null,
        living_setting: recipient?.living_setting ?? null,
        pays_home_support_services: 'unknown',
        domestic_help: needs?.services_in_place.includes('domestic_help') ? 'yes' : 'unknown',
        severe_prolonged_impairment: 'unknown',
        impairment_dependency: 'unknown',
        caregiver_cohabits: 'unknown',
        needs_home_adaptation: needs?.home_adaptation_needs?.trim() ? 'yes' : 'unknown'
    };
}

function Results({ programs, answers, filePrograms }: { programs: Program[]; answers: BenefitAnswers; filePrograms: FileProgram[] }) {
    const results = assessPrograms(
        programs.filter((p) => p.is_active),
        factsFromAnswers(answers)
    );
    const byProgram = new Map(filePrograms.map((fp) => [fp.program_id, fp]));
    const group = (level: 'likely' | 'possible' | 'unlikely') => results.filter((r) => r.assessment.level === level);
    const unlikely = group('unlikely');
    const list = (items: typeof results) =>
        items.length === 0 ? (
            <p className="text-muted">{tb.none}</p>
        ) : (
            <ul className="flex list-none flex-col gap-3 p-0">
                {items.map(({ program, assessment }) => (
                    <li key={program.id}>
                        <ProgramCard program={program} assessment={assessment} fileProgram={byProgram.get(program.id)} />
                    </li>
                ))}
            </ul>
        );

    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="likely-title" className="flex flex-col gap-3">
                <h2 id="likely-title" className="text-2xl font-bold">
                    {tb.likelyTitle}
                </h2>
                {list(group('likely'))}
            </section>
            <section aria-labelledby="possible-title" className="flex flex-col gap-3">
                <h2 id="possible-title" className="text-2xl font-bold">
                    {tb.possibleTitle}
                </h2>
                {list(group('possible'))}
            </section>
            {unlikely.length > 0 && (
                <section aria-labelledby="unlikely-title" className="flex flex-col gap-3">
                    <h2 id="unlikely-title" className="text-2xl font-bold">
                        {tb.unlikelyTitle}
                    </h2>
                    <details>
                        <summary className="min-h-12 cursor-pointer py-3 font-bold text-brand">{tb.unlikelyCount(unlikely.length)}</summary>
                        {list(unlikely)}
                    </details>
                </section>
            )}
        </div>
    );
}

const TRI_OPTIONS: Array<{ value: TriState; label: string }> = [
    { value: 'yes', label: tb.yes },
    { value: 'no', label: tb.no },
    { value: 'unknown', label: tb.unknown }
];

function Questionnaire({
    fileId,
    programs,
    initial,
    onDone,
    onCancel
}: {
    fileId: string;
    programs: Program[];
    initial: BenefitAnswers;
    onDone: () => void;
    onCancel?: () => void;
}) {
    const queryClient = useQueryClient();
    const [answers, setAnswers] = useState<BenefitAnswers>(initial);
    const [age, setAge] = useState(initial.recipient_age === null ? '' : String(initial.recipient_age));
    const [ageError, setAgeError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const parsedAge = age.trim() === '' ? null : Number(age);
        if (parsedAge !== null && (!Number.isInteger(parsedAge) || parsedAge < 18 || parsedAge > 120)) return setAgeError(tb.ageError);
        setAgeError(null);
        const final = { ...answers, recipient_age: parsedAge };
        const results = assessPrograms(
            programs.filter((p) => p.is_active),
            factsFromAnswers(final)
        );
        setBusy(true);
        setError(null);
        try {
            await saveAssessment(
                fileId,
                final,
                results.map((r) => ({ programId: r.program.id, assessment: r.assessment }))
            );
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: benefitKeys.answers(fileId) }),
                queryClient.invalidateQueries({ queryKey: benefitKeys.filePrograms(fileId) })
            ]);
            onDone();
        } catch {
            setError(fr.app.genericError);
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate aria-labelledby="questionnaire-title" className="flex flex-col gap-5">
            <h2 id="questionnaire-title" className="text-2xl font-bold">
                {tb.questionnaireTitle}
            </h2>
            <TextField
                label={tb.age}
                hint={tb.ageHint}
                inputMode="numeric"
                value={age}
                error={ageError}
                maxLength={3}
                onChange={(e) => setAge(e.target.value)}
            />
            <RadioGroup
                legend={tb.livingSetting}
                name="living-setting"
                value={answers.living_setting}
                options={LIVING_SETTINGS.map((s) => ({ value: s, label: LIVING_SETTING_LABELS[s] ?? s }))}
                onChange={(value) => setAnswers((a) => ({ ...a, living_setting: value as LivingSetting }))}
            />
            {QUESTION_FACTS.map((fact) => (
                <div key={fact} className="flex flex-col gap-1">
                    <RadioGroup
                        legend={QUESTIONS[fact].label}
                        name={fact}
                        value={answers[fact]}
                        options={TRI_OPTIONS.map((o) => ({ ...o, description: undefined }))}
                        onChange={(value) => setAnswers((a) => ({ ...a, [fact]: value }))}
                    />
                    {QUESTIONS[fact].hint && <p className="text-muted">{QUESTIONS[fact].hint}</p>}
                </div>
            ))}
            {error && <Notice tone="error">{error}</Notice>}
            <div className="flex flex-col gap-3 sm:flex-row">
                <Button type="submit" disabled={busy}>
                    {busy ? tb.saving : tb.submit}
                </Button>
                {onCancel && (
                    <Button variant="secondary" onClick={onCancel}>
                        {tb.cancel}
                    </Button>
                )}
            </div>
        </form>
    );
}
