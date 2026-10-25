import { Link } from 'react-router';
import { useSession } from '../../app/session';
import { buttonClass, Card, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';

export function LandingPage() {
    const { session } = useSession();
    return (
        <div className="flex flex-col gap-6">
            <PageTitle>{fr.landing.title}</PageTitle>
            <p className="text-xl">{fr.landing.lead}</p>
            <div>
                <p className="font-bold">{fr.landing.listTitle}</p>
                <ul className="mt-2 list-disc pl-6">
                    {fr.landing.list.map((item) => (
                        <li key={item}>{item}</li>
                    ))}
                </ul>
                <p className="mt-2 text-muted">{fr.landing.pilot}</p>
            </div>
            <Card className="border-l-4 border-l-urgent">
                <h2 className="text-xl font-bold">{fr.landing.notTitle}</h2>
                <p className="mt-2">{fr.landing.notText}</p>
            </Card>
            <div className="flex flex-col gap-3 sm:flex-row">
                {session ? (
                    <Link to="/accueil" className={buttonClass('primary')}>
                        {fr.landing.continue}
                    </Link>
                ) : (
                    <Link to="/connexion" className={buttonClass('primary')}>
                        {fr.landing.start}
                    </Link>
                )}
                <Link to="/confidentialite" className={buttonClass('secondary')}>
                    {fr.landing.privacyLink}
                </Link>
            </div>
        </div>
    );
}
