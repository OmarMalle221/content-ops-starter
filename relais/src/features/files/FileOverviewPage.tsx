import { useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../../app/session';
import { buttonClass, Card, PageTitle } from '../../components/ui';
import { coordination as tc } from '../../i18n/coordination.fr';
import { files as tf, GRANTOR_LABELS, LIVING_SETTING_LABELS, SERVICE_LABELS } from '../../i18n/files.fr';
import { formatDate, formatDay, formatTime } from '../../lib/format';
import { isPast } from '../coordination/AgendaPages';
import { useAppointments, useTasks } from '../coordination/useCoordination';
import { useFileContext } from './FileLayout';
import { useCareNeeds, useCareRecipient, useContacts, useMembers } from './useFile';

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Les 7 prochains jours : rendez-vous à venir et tâches confiées à la personne connectée. */
function ThisWeek({ fileId }: { fileId: string }) {
    const { session } = useSession();
    const appointments = useAppointments(fileId);
    const tasks = useTasks(fileId);
    // Heure figée à l'affichage de la page (rendu pur).
    const [now] = useState(() => Date.now());
    const next = (appointments.data ?? []).filter((a) => !isPast(a, now) && new Date(a.starts_at).getTime() < now + WEEK).slice(0, 3);
    const mine = (tasks.data ?? []).filter((t) => t.status === 'todo' && t.assignee_id === session?.user.id).length;
    return (
        <Card className="flex flex-col gap-3">
            <h2 className="text-xl font-bold">{tc.weekTitle}</h2>
            <div>
                <h3 className="font-bold">{tc.nextAppointments}</h3>
                {next.length === 0 ? (
                    <p className="text-muted">{tc.noNextAppointments}</p>
                ) : (
                    <ul className="flex list-none flex-col gap-1 p-0">
                        {next.map((a) => (
                            <li key={a.id}>
                                <Link to={`agenda/${a.id}`} className="font-bold text-brand underline underline-offset-4">
                                    {formatDay(a.starts_at)}, {formatTime(a.starts_at)} — {a.title}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <p>{tc.myTasks(mine)}</p>
            <div className="flex flex-wrap gap-2">
                <Link to="agenda" className={buttonClass('secondary')}>
                    {tc.seeAgenda}
                </Link>
                <Link to="taches" className={buttonClass('secondary')}>
                    {tc.seeTasks}
                </Link>
            </div>
        </Card>
    );
}

export function FileOverviewPage() {
    const { file, access } = useFileContext();
    const recipient = useCareRecipient(file.id);
    const needs = useCareNeeds(file.id, access.canRead('health'));
    const contacts = useContacts(file.id);
    const members = useMembers(file.id);
    const r = recipient.data;
    const age = r?.birth_year ? new Date().getFullYear() - r.birth_year : null;

    return (
        <div className="flex flex-col gap-4">
            <PageTitle>{file.title}</PageTitle>
            <ThisWeek fileId={file.id} />

            <Card>
                <h2 className="text-xl font-bold">{tf.profileTitle}</h2>
                {r ? (
                    <ul className="mt-2 flex flex-col gap-1">
                        <li className="font-bold">
                            {[r.first_name, r.last_name].filter(Boolean).join(' ')}
                            {age !== null && `, ${tf.age(age)}`}
                        </li>
                        <li>
                            {LIVING_SETTING_LABELS[r.living_setting]}
                            {r.residence_name && ` : ${r.residence_name}`}
                            {r.living_setting_since && `, ${tf.since(formatDate(r.living_setting_since))}`}
                        </li>
                        {r.chsld_waitlist && (
                            <li>{r.chsld_waitlist_since ? tf.chsldWaitlistSince(formatDate(r.chsld_waitlist_since)) : tf.chsldWaitlist}</li>
                        )}
                    </ul>
                ) : (
                    <p className="mt-2 text-muted">{tf.profileMissing}</p>
                )}
                {access.canWrite('profile') && (
                    <Link to="profil" className={buttonClass('secondary', 'mt-3')}>
                        {r ? tf.tabs.profile : tf.completeProfile}
                    </Link>
                )}
            </Card>

            {access.canRead('health') && needs.data && needs.data.services_in_place.length > 0 && (
                <Card>
                    <h2 className="text-xl font-bold">{tf.services}</h2>
                    <ul className="mt-2 list-disc pl-6">
                        {needs.data.services_in_place.map((s) => (
                            <li key={s}>{SERVICE_LABELS[s] ?? s}</li>
                        ))}
                    </ul>
                </Card>
            )}

            <Card>
                <h2 className="text-xl font-bold">{tf.tabs.contacts}</h2>
                <p className="mt-2">{tf.contactsCount(contacts.data?.length ?? 0)}</p>
                <Link to="contacts" className={buttonClass('secondary', 'mt-3')}>
                    {tf.tabs.contacts}
                </Link>
            </Card>

            <Card>
                <h2 className="text-xl font-bold">{tf.tabs.members}</h2>
                <p className="mt-2">{tf.membersCount(members.data?.length ?? 1)}</p>
            </Card>

            <Card>
                <h2 className="text-xl font-bold">{tf.consentTitle}</h2>
                <p className="mt-2">
                    {access.recipientConsent
                        ? `${GRANTOR_LABELS[access.recipientConsent.granted_by] ?? ''} — ${tf.consentRecordedOn(formatDate(access.recipientConsent.granted_at))}`
                        : tf.consentNone}
                </p>
            </Card>
        </div>
    );
}
