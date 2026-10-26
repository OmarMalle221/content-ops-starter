import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useHelpResources, useMyConsents } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, buttonClass, Card, Loading, Notice, PageTitle, RadioGroup } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { SCALE_LABELS, support as ts } from '../../i18n/support.fr';
import { activeConsent } from '../../lib/consents';
import { formatDate } from '../../lib/format';
import { saveCheckin } from '../../lib/support';
import {
    CHECKIN_QUESTIONS,
    isValidAnswers,
    needsSupport,
    weekStart,
    type CheckinAnswers,
    type CheckinQuestion
} from '../../shared/checkin/score';
import { HelpResourceList } from '../help/HelpResourceList';
import { supportKeys, useMyCheckins } from './useSupport';

const SCALE = SCALE_LABELS.map((label, i) => ({ value: String(i + 1), label: `${i + 1} — ${label}` }));

/**
 * Bilan de la semaine : 3 questions pour l'aidant. Résultat calculé sur le téléphone ; réponses gardées
 * seulement avec le consentement « Mon bilan de la semaine », et visibles par la personne seulement.
 */
export function CheckinPage() {
    const consents = useMyConsents();
    const keep = consents.data ? activeConsent(consents.data, 'caregiver_checkin') !== undefined : false;
    const history = useMyCheckins(keep);
    const resources = useHelpResources();
    const queryClient = useQueryClient();
    const { session } = useSession();
    const week = weekStart();
    const [answers, setAnswers] = useState<Partial<Record<CheckinQuestion, number>>>({});
    const [result, setResult] = useState<CheckinAnswers | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState(false);

    if (consents.isPending || (keep && history.isPending)) return <Loading />;
    const thisWeek = history.data?.find((c) => c.week_start === week) ?? null;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!isValidAnswers(answers)) return setError(ts.checkinError);
        setError(null);
        setResult(answers);
        if (!keep) return;
        try {
            await saveCheckin(week, answers, thisWeek?.id ?? null);
            await queryClient.invalidateQueries({ queryKey: supportKeys.checkins(session?.user.id) });
            setSaveError(false);
        } catch {
            setSaveError(true);
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{ts.checkinTitle}</PageTitle>
            <p>{ts.checkinIntro}</p>
            {keep ? (
                <p className="text-muted">{ts.keptPrivate}</p>
            ) : (
                <p className="text-muted">
                    {ts.notKept}{' '}
                    <Link to="/mes-consentements" className="font-bold text-brand underline underline-offset-4">
                        {ts.keepLink}
                    </Link>
                </p>
            )}

            {result ? (
                <Result answers={result} resources={resources} onRedo={() => setResult(null)} saveError={saveError} />
            ) : (
                <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5">
                    {error && <Notice tone="error">{error}</Notice>}
                    {CHECKIN_QUESTIONS.map((q) => (
                        <RadioGroup
                            key={q}
                            legend={ts.questions[q]}
                            name={`checkin-${q}`}
                            value={answers[q] ? String(answers[q]) : null}
                            options={SCALE}
                            onChange={(value) => setAnswers((a) => ({ ...a, [q]: Number(value) }))}
                        />
                    ))}
                    <Button type="submit" className="self-start">
                        {ts.seeResult}
                    </Button>
                </form>
            )}

            {keep && (history.data ?? []).length > 0 && (
                <section aria-labelledby="checkin-history" className="flex flex-col gap-2">
                    <h2 id="checkin-history" className="text-2xl font-bold">
                        {ts.historyTitle}
                    </h2>
                    <ul className="flex list-none flex-col gap-2 p-0">
                        {(history.data ?? []).map((c) => (
                            <li key={c.id} className="rounded-lg bg-surface p-3">
                                <p className="font-bold">{ts.weekOf(formatDate(c.week_start))}</p>
                                <p>{ts.historyLine(c.fatigue, c.overwhelm, c.isolation)}</p>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

function Result({
    answers,
    resources,
    onRedo,
    saveError
}: {
    answers: CheckinAnswers;
    resources: ReturnType<typeof useHelpResources>;
    onRedo: () => void;
    saveError: boolean;
}) {
    const heavy = needsSupport(answers);
    return (
        <section aria-labelledby="checkin-result" className="flex flex-col gap-4">
            <Card className={heavy ? 'border-l-4 border-l-urgent' : 'border-l-4 border-l-brand'}>
                <h2 id="checkin-result" className="text-2xl font-bold">
                    {heavy ? ts.heavyTitle : ts.lightTitle}
                </h2>
                <p className="mt-2">{heavy ? ts.heavyText : ts.lightText}</p>
                {heavy && (
                    <Link to="/parler-a-une-intervenante?origine=bilan" className={buttonClass('primary', 'mt-4')}>
                        {ts.talkToWorker}
                    </Link>
                )}
            </Card>
            {saveError && <Notice tone="error">{fr.app.genericError}</Notice>}
            <HelpResourceList
                resources={resources}
                categories={heavy ? ['caregiver_support', 'respite', 'psychosocial_line'] : ['caregiver_support', 'respite']}
            />
            <Button variant="secondary" className="self-start" onClick={onRedo}>
                {ts.redo}
            </Button>
        </section>
    );
}
