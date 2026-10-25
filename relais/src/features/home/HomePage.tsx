import { Link } from 'react-router';
import { useMyConsents, useProfile } from '../../app/queries';
import { buttonClass, Card, Loading, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { activeConsent } from '../../lib/consents';

export function HomePage() {
    const profile = useProfile();
    const consents = useMyConsents();
    if (profile.isPending || consents.isPending) return <Loading />;
    const name = profile.data?.display_name ?? '';
    const healthGranted = consents.data ? activeConsent(consents.data, 'health_information') !== undefined : true;

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.home.greeting(name)}</PageTitle>
            <Card>
                <h2 className="text-xl font-bold">{fr.home.fileTitle}</h2>
                <p className="mt-2">{fr.home.fileSoon}</p>
            </Card>
            {!healthGranted && (
                <Card className="border-l-4 border-l-brand">
                    <p>{fr.home.healthReminder}</p>
                    <Link to="/mes-consentements" className={buttonClass('quiet', 'mt-2 px-0')}>
                        {fr.home.healthLink}
                    </Link>
                </Card>
            )}
            <nav aria-label={fr.home.shortcuts} className="flex flex-col gap-3 sm:flex-row">
                <Link to="/mes-consentements" className={buttonClass('secondary')}>
                    {fr.nav.consents}
                </Link>
                <Link to="/compte" className={buttonClass('secondary')}>
                    {fr.nav.account}
                </Link>
            </nav>
        </div>
    );
}
