import { Link } from 'react-router';
import { buttonClass, Card, PageTitle } from '../../components/ui';
import { files as tf, GRANTOR_LABELS, LIVING_SETTING_LABELS, SERVICE_LABELS } from '../../i18n/files.fr';
import { formatDate } from '../../lib/format';
import { useFileContext } from './FileLayout';
import { useCareNeeds, useCareRecipient, useContacts, useMembers } from './useFile';

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
