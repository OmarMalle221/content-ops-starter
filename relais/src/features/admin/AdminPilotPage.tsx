// Mesures du pilote (admin + MFA) : agrégats seulement, calculés par la base (pilot_metrics). Les réponses
// de moins de 3 personnes sont masquées ; le bilan de la semaine des aidants n'y figure jamais.
import { useProfile } from '../../app/queries';
import { Card, Loading, Notice, PageTitle } from '../../components/ui';
import { benefits as tb } from '../../i18n/benefits.fr';
import { fr } from '../../i18n/fr';
import { SATISFACTION_LABELS, support as ts } from '../../i18n/support.fr';
import { formatDate } from '../../lib/format';
import { usePilotMetrics } from '../support/useSupport';

const number = (value: number | null | undefined) =>
    value === null || value === undefined ? ts.noData : value.toLocaleString('fr-CA', { maximumFractionDigits: 1 });

export function AdminPilotPage() {
    const profile = useProfile();
    const isAdmin = profile.data?.app_role === 'admin';
    const metrics = usePilotMetrics(isAdmin);
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{ts.pilotTitle}</PageTitle>
            {profile.isPending ? (
                <Loading />
            ) : !isAdmin ? (
                <Notice tone="info">{tb.adminOnly}</Notice>
            ) : metrics.isPending ? (
                <Loading />
            ) : metrics.isError || !metrics.data ? (
                <Notice tone="error">{fr.app.genericError}</Notice>
            ) : (
                <Metrics data={metrics.data} />
            )}
        </div>
    );
}

function Metrics({ data }: { data: NonNullable<ReturnType<typeof usePilotMetrics>['data']> }) {
    const f = data.feedback;
    return (
        <>
            <p>{ts.pilotIntro}</p>
            <Card className="flex flex-col gap-1">
                <h2 className="text-xl font-bold">{ts.participation}</h2>
                <p>{ts.careFiles(data.participation.care_files)}</p>
                <p>{ts.members(data.participation.members)}</p>
                <p>{ts.pilotConsents(data.participation.pilot_consents)}</p>
            </Card>
            <Card className="flex flex-col gap-1">
                <h2 className="text-xl font-bold">{ts.feedbackSection}</h2>
                {f.suppressed ? (
                    <p>{ts.suppressed(f.respondents, data.minimum_respondents)}</p>
                ) : (
                    <>
                        <p>{ts.respondents(f.respondents, f.responses ?? 0)}</p>
                        <p>{ts.hoursAvg(number(f.hours_saved_avg))}</p>
                        <p>{ts.satisfactionAvg(number(f.satisfaction_avg))}</p>
                        <ul className="list-disc pl-6">
                            {SATISFACTION_LABELS.map((label, i) => (
                                <li key={label}>{ts.satisfactionCount(`${i + 1} — ${label}`, f.satisfaction?.[String(i + 1)] ?? 0)}</li>
                            ))}
                        </ul>
                    </>
                )}
                {data.feedback_by_week.length > 0 && (
                    <>
                        <h3 className="mt-2 font-bold">{ts.byWeek}</h3>
                        <ul className="list-disc pl-6">
                            {data.feedback_by_week.map((w) => (
                                <li key={w.week_start}>
                                    {ts.weekRow(formatDate(w.week_start))} :{' '}
                                    {w.suppressed
                                        ? ts.weekSuppressed
                                        : ts.weekValues(number(w.hours_saved_avg), number(w.satisfaction_avg), w.respondents)}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </Card>
            <Card className="flex flex-col gap-1">
                <h2 className="text-xl font-bold">{ts.programsSection}</h2>
                <p>{ts.programsLine(data.programs.identified, data.programs.requested, data.programs.obtained, data.programs.refused)}</p>
                <p>{ts.medianDays(number(data.programs.median_days_to_request))}</p>
            </Card>
            <Card className="flex flex-col gap-1">
                <h2 className="text-xl font-bold">{ts.supportSection}</h2>
                <p>{ts.supportLine(data.support.total, data.support.new + data.support.assigned, data.support.closed)}</p>
                <p>{ts.supportOrigins(data.support.from_button, data.support.from_distress_screen, data.support.from_checkin)}</p>
                <p>{ts.medianHours(number(data.support.median_hours_to_assignment))}</p>
            </Card>
            <p className="text-muted">{ts.generatedAt(formatDate(data.generated_at))}</p>
        </>
    );
}
