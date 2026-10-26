import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMyConsents } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, Loading, Notice, PageTitle, RadioGroup, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { SATISFACTION_LABELS, support as ts } from '../../i18n/support.fr';
import { activeConsent } from '../../lib/consents';
import { formatDate } from '../../lib/format';
import { saveFeedback, type PilotFeedback } from '../../lib/support';
import { weekStart } from '../../shared/checkin/score';
import { supportKeys, useMyFeedback } from './useSupport';

const SATISFACTION = SATISFACTION_LABELS.map((label, i) => ({ value: String(i + 1), label: `${i + 1} — ${label}` }));

/** Évaluation du pilote : 2 questions facultatives par semaine (consentement « pilot_evaluation »). */
export function FeedbackPage() {
    const consents = useMyConsents();
    const consented = consents.data ? activeConsent(consents.data, 'pilot_evaluation') !== undefined : false;
    const feedback = useMyFeedback(consented);
    if (consents.isPending || (consented && feedback.isPending)) return <Loading />;
    const week = weekStart();
    const current = feedback.data?.find((f) => f.week_start === week) ?? null;

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{ts.feedbackTitle}</PageTitle>
            {consented ? (
                <>
                    <p>{ts.feedbackIntro}</p>
                    <h2 className="text-xl font-bold">{ts.feedbackThisWeek(formatDate(week))}</h2>
                    <FeedbackForm week={week} current={current} />
                </>
            ) : (
                <Notice tone="info">
                    <p>{ts.feedbackNoConsent}</p>
                    <Link
                        to="/mes-consentements"
                        className="mt-2 inline-flex min-h-12 items-center font-bold text-brand underline underline-offset-4"
                    >
                        {ts.feedbackConsentLink}
                    </Link>
                </Notice>
            )}
        </div>
    );
}

function FeedbackForm({ week, current }: { week: string; current: PilotFeedback | null }) {
    const queryClient = useQueryClient();
    const { session } = useSession();
    const [hours, setHours] = useState(
        current?.hours_saved !== null && current?.hours_saved !== undefined ? String(current.hours_saved).replace('.', ',') : ''
    );
    const [satisfaction, setSatisfaction] = useState<string | null>(current?.satisfaction ? String(current.satisfaction) : null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const parsed = hours.trim() === '' ? null : Number(hours.replace(',', '.'));
        if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 80 || !Number.isInteger(parsed * 2))) {
            return setError(ts.hoursError);
        }
        if (parsed === null && satisfaction === null) return setError(ts.feedbackEmpty);
        setError(null);
        try {
            await saveFeedback(
                week,
                { hours_saved: parsed, satisfaction: satisfaction ? Number(satisfaction) : null },
                current?.id ?? null
            );
            await queryClient.invalidateQueries({ queryKey: supportKeys.feedback(session?.user.id) });
            setStatus({ tone: 'success', text: ts.feedbackSaved });
        } catch {
            setStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5">
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <TextField
                label={ts.hours}
                hint={ts.hoursHint}
                inputMode="decimal"
                value={hours}
                maxLength={4}
                error={error === ts.hoursError ? error : null}
                onChange={(e) => setHours(e.target.value)}
            />
            <RadioGroup
                legend={ts.satisfaction}
                name="satisfaction"
                value={satisfaction}
                options={SATISFACTION}
                onChange={setSatisfaction}
            />
            {error === ts.feedbackEmpty && <Notice tone="error">{error}</Notice>}
            <Button type="submit" className="self-start">
                {ts.feedbackSave}
            </Button>
        </form>
    );
}
