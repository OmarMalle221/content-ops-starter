import { Link } from 'react-router';
import { useMyConsents, useProfile } from '../../app/queries';
import { buttonClass, Card, Loading, Notice, PageTitle } from '../../components/ui';
import { benefits as tb } from '../../i18n/benefits.fr';
import { fr } from '../../i18n/fr';
import { ACCESS_LABELS, files as tf, ROLE_LABELS } from '../../i18n/files.fr';
import { activeConsent } from '../../lib/consents';
import { useMyFiles } from '../files/useFile';
import { pendingInvitationToken } from '../invitations/InvitationPage';

export function HomePage() {
    const profile = useProfile();
    const consents = useMyConsents();
    const myFiles = useMyFiles();
    if (profile.isPending || consents.isPending || myFiles.isPending) return <Loading />;
    const name = profile.data?.display_name ?? '';
    const healthGranted = consents.data ? activeConsent(consents.data, 'health_information') !== undefined : true;
    const files = myFiles.data ?? [];

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.home.greeting(name)}</PageTitle>

            {pendingInvitationToken() && (
                <Notice tone="info">
                    <p>{tf.pendingInvitation}</p>
                    <Link to="/invitation" className={buttonClass('primary', 'mt-3')}>
                        {tf.seeInvitation}
                    </Link>
                </Notice>
            )}

            {profile.data?.app_role === 'admin' && (
                <Link to="/admin" className={buttonClass('secondary')}>
                    {tb.adminTitle}
                </Link>
            )}

            <section aria-labelledby="files-title" className="flex flex-col gap-3">
                <h2 id="files-title" className="text-2xl font-bold">
                    {tf.myFiles}
                </h2>
                {files.length === 0 ? (
                    <p>{tf.emptyFiles}</p>
                ) : (
                    <ul className="flex list-none flex-col gap-3 p-0">
                        {files.map(({ file, membership }) => (
                            <li key={file.id}>
                                <Link
                                    to={`/dossiers/${file.id}`}
                                    className="flex min-h-12 flex-col rounded-xl border-2 border-line bg-surface p-4 hover:border-brand"
                                >
                                    <span className="text-xl font-bold text-brand-strong">{file.title}</span>
                                    <span className="text-muted">
                                        {tf.yourRole(ROLE_LABELS[membership.role] ?? membership.role)} —{' '}
                                        {ACCESS_LABELS[membership.access_level]}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
                <Link to="/dossiers/nouveau" className={buttonClass(files.length === 0 ? 'primary' : 'secondary')}>
                    {tf.createFile}
                </Link>
            </section>

            {!healthGranted && (
                <Card className="border-l-4 border-l-brand">
                    <p>{fr.home.healthReminder}</p>
                    <Link to="/mes-consentements" className={buttonClass('quiet', 'mt-2 px-0')}>
                        {fr.home.healthLink}
                    </Link>
                </Card>
            )}
        </div>
    );
}
