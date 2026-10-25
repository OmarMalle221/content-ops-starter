// « Préparer un rendez-vous » : page à imprimer, construite SANS IA à partir du dossier. Chaque élément
// porte sa source (profil, document, note à la main, questions de la famille). Rien n'est ajouté ni
// interprété. L'impression est notée au journal des accès (renseignements de santé).
import { Link, useParams } from 'react-router';
import { Button, Loading, Notice, PageTitle } from '../../components/ui';
import { coordination as tc } from '../../i18n/coordination.fr';
import { files as tf, LIVING_SETTING_LABELS, SERVICE_LABELS } from '../../i18n/files.fr';
import { logPrepSheetPrinted } from '../../lib/coordination';
import type { CareDocument } from '../../lib/documents';
import { formatDate, formatDay, formatTime, localDate } from '../../lib/format';
import { DOCUMENT_TYPE_LABELS, TIMELINE_EVENT_LABELS } from '../../shared/extraction/labels.fr';
import { useDocuments, useMedications, useTimeline } from '../documents/useDocuments';
import { useFileContext } from '../files/FileLayout';
import { useCareNeeds, useCareRecipient, useMembers } from '../files/useFile';
import { memberName, useAppointments, useQuestions } from './useCoordination';

const RECENT_DAYS = 90;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Lignes pour écrire les réponses à la main (version imprimée seulement). */
function AnswerLines({ count }: { count: number }) {
    return (
        <div className="print-only" aria-hidden="true">
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className="h-8 border-b border-ink" />
            ))}
        </div>
    );
}

function documentSource(documents: CareDocument[] | undefined, id: string | null): string {
    const doc = documents?.find((d) => d.id === id);
    const title = doc?.title ?? (doc?.doc_type ? DOCUMENT_TYPE_LABELS[doc.doc_type] : tc.untitledDocument);
    return tc.sourceDocument(title, doc?.doc_date ? formatDate(doc.doc_date) : null);
}

/** Jour (AAAA-MM-JJ) décalé de n jours. */
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function PrepSheetPage() {
    const { appointmentId = '' } = useParams();
    const { file, access } = useFileContext();
    const canReadHealth = access.canRead('health');
    const appointments = useAppointments(file.id);
    const questions = useQuestions(appointmentId, canReadHealth);
    const recipient = useCareRecipient(file.id);
    const needs = useCareNeeds(file.id, canReadHealth);
    const timeline = useTimeline(file.id, canReadHealth);
    const medications = useMedications(file.id, canReadHealth);
    const documents = useDocuments(file.id, canReadHealth);
    const members = useMembers(file.id);

    if (!canReadHealth) return <Notice tone="info">{tc.prepHealthOnly}</Notice>;
    if (
        appointments.isPending ||
        questions.isPending ||
        recipient.isPending ||
        needs.isPending ||
        timeline.isPending ||
        medications.isPending ||
        documents.isPending
    ) {
        return <Loading />;
    }
    const appointment = appointments.data?.find((a) => a.id === appointmentId);
    if (!appointment) return <Notice tone="error">{tc.appointmentNotFound}</Notice>;

    const r = recipient.data;
    const n = needs.data;
    const day = localDate(appointment.starts_at);
    const from = shiftDay(day, -RECENT_DAYS);
    const changes = (timeline.data ?? []).filter((e) => e.occurred_on >= from && e.occurred_on <= day);
    const meds = medications.data ?? [];
    const asked = questions.data ?? [];
    const age = r?.birth_year ? new Date().getFullYear() - r.birth_year : null;

    async function print() {
        await logPrepSheetPrinted(file.id, appointmentId).catch(() => undefined);
        window.print();
    }

    return (
        <article className="prep-sheet flex flex-col gap-5">
            <Link to=".." relative="path" className="no-print self-start font-bold text-brand underline underline-offset-4">
                {appointment.title}
            </Link>
            <PageTitle>{tc.prepTitle}</PageTitle>
            <p className="no-print">{tc.prepIntro}</p>
            <div className="no-print flex flex-col gap-2">
                <Button className="self-start" onClick={() => void print()}>
                    {tc.print}
                </Button>
                <p className="text-muted">{tc.printHint}</p>
            </div>

            <section aria-labelledby="prep-appointment" className="flex flex-col gap-1">
                <h2 id="prep-appointment" className="text-2xl font-bold">
                    {appointment.title}
                </h2>
                <p>
                    {capitalize(formatDay(appointment.starts_at))},{' '}
                    {tc.timeRange(formatTime(appointment.starts_at), appointment.ends_at ? formatTime(appointment.ends_at) : null)}
                    {appointment.location ? ` — ${appointment.location}` : ''}
                </p>
                {appointment.companion_id && (
                    <p>
                        {tc.with} : {memberName(members.data, appointment.companion_id, undefined)}
                    </p>
                )}
            </section>

            <section aria-labelledby="prep-person" className="flex flex-col gap-1">
                <h2 id="prep-person" className="text-xl font-bold">
                    {tc.prepPerson}
                </h2>
                {r ? (
                    <>
                        <p className="font-bold">
                            {[r.first_name, r.last_name].filter(Boolean).join(' ')}
                            {age !== null ? `, ${tc.prepAge(age)}` : ''}
                        </p>
                        <p>
                            {tc.prepLivingSetting} : {LIVING_SETTING_LABELS[r.living_setting]}
                            {r.residence_name ? ` (${tc.prepResidence.toLowerCase()} : ${r.residence_name})` : ''}
                        </p>
                        {r.chsld_waitlist && <p>{tc.prepWaitlist(r.chsld_waitlist_since ? formatDate(r.chsld_waitlist_since) : null)}</p>}
                        <p className="source text-muted">{tc.sourceProfile}</p>
                    </>
                ) : (
                    <p className="text-muted">{tf.profileMissing}</p>
                )}
            </section>

            {n && (n.autonomy_description || n.services_in_place.length > 0 || n.home_adaptation_needs) && (
                <section aria-labelledby="prep-needs" className="flex flex-col gap-1">
                    <h2 id="prep-needs" className="text-xl font-bold">
                        {tc.prepNeeds}
                    </h2>
                    {n.autonomy_description && <p className="whitespace-pre-line">{n.autonomy_description}</p>}
                    {n.services_in_place.length > 0 && (
                        <p>
                            {tc.prepServices} : {n.services_in_place.map((s) => SERVICE_LABELS[s] ?? s).join(', ')}
                        </p>
                    )}
                    {n.home_adaptation_needs && (
                        <p>
                            {tc.prepAdaptation} : {n.home_adaptation_needs}
                        </p>
                    )}
                    <p className="source text-muted">{tc.sourceProfile}</p>
                </section>
            )}

            <section aria-labelledby="prep-changes" className="flex flex-col gap-2">
                <h2 id="prep-changes" className="text-xl font-bold">
                    {tc.prepChanges}
                </h2>
                {changes.length === 0 && <p className="text-muted">{tc.prepNoChanges}</p>}
                <ul className="flex list-none flex-col gap-2 p-0">
                    {changes.map((e) => (
                        <li key={e.id} data-testid="prep-fact">
                            <p>
                                <span className="font-bold">{formatDate(e.occurred_on)}</span> — {TIMELINE_EVENT_LABELS[e.event_type]} :{' '}
                                {e.title}
                                {e.description ? ` (${e.description})` : ''}
                            </p>
                            <p className="source text-muted">
                                {e.source_type === 'document'
                                    ? documentSource(documents.data, e.source_document_id)
                                    : tc.sourceManual(memberName(members.data, e.created_by, undefined))}
                            </p>
                        </li>
                    ))}
                </ul>
            </section>

            <section aria-labelledby="prep-medications" className="flex flex-col gap-2">
                <h2 id="prep-medications" className="text-xl font-bold">
                    {tc.prepMedications}
                </h2>
                {meds.length === 0 ? (
                    <p className="text-muted">{tc.prepNoMedications}</p>
                ) : (
                    <>
                        <p>{tc.prepMedicationsNote}</p>
                        <ul className="flex list-none flex-col gap-2 p-0">
                            {meds.map((m) => (
                                <li key={m.id} data-testid="prep-fact">
                                    <p className="font-bold">
                                        {[m.name_as_written, m.dosage_as_written, m.frequency_as_written].filter(Boolean).join(' — ')}
                                    </p>
                                    <p className="source text-muted">{documentSource(documents.data, m.source_document_id)}</p>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </section>

            <section aria-labelledby="prep-questions" className="flex flex-col gap-2">
                <h2 id="prep-questions" className="text-xl font-bold">
                    {tc.prepQuestions}
                </h2>
                {asked.length === 0 ? (
                    <p className="text-muted">{tc.prepNoQuestions}</p>
                ) : (
                    <>
                        <ol className="flex list-decimal flex-col gap-3 pl-6">
                            {asked.map((q) => (
                                <li key={q.id}>
                                    <p>{q.question}</p>
                                    <AnswerLines count={2} />
                                </li>
                            ))}
                        </ol>
                        <p className="source text-muted">{tc.sourceFamily}</p>
                    </>
                )}
                <div className="print-only">
                    <p className="font-bold">{tc.prepAnswerLines}</p>
                    <AnswerLines count={6} />
                </div>
            </section>

            <footer className="border-t border-line pt-3 text-muted">
                <p>{tc.preparedOn(formatDate(new Date().toISOString()))}</p>
                <p>{tc.printHint}</p>
            </footer>
        </article>
    );
}
