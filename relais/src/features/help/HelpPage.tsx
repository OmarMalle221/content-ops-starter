import { Link } from 'react-router';
import { useHelpResources } from '../../app/queries';
import { useSession } from '../../app/session';
import { buttonClass, Notice, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { support as ts } from '../../i18n/support.fr';
import { HelpResourceList } from './HelpResourceList';

/** Page publique, accessible sans connexion depuis l'en-tête de chaque page. */
export function HelpPage() {
    const resources = useHelpResources();
    const { session } = useSession();
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.help.title}</PageTitle>
            <Notice tone="error">
                <p className="font-bold">{fr.help.lead}</p>
            </Notice>
            <HelpResourceList resources={resources} categories={['emergency', 'crisis_line', 'psychosocial_line']} />
            <section aria-labelledby="health-title" className="flex flex-col gap-3">
                <h2 id="health-title" className="text-2xl font-bold">
                    {fr.help.healthTitle}
                </h2>
                <p>{fr.help.healthText}</p>
                <HelpResourceList resources={resources} categories={['health_line']} headingLevel="h3" />
            </section>
            <section aria-labelledby="caregiver-title" className="flex flex-col gap-3">
                <h2 id="caregiver-title" className="text-2xl font-bold">
                    {fr.help.caregiverTitle}
                </h2>
                <p>{fr.help.caregiverText}</p>
                <HelpResourceList resources={resources} categories={['caregiver_support', 'respite', 'elder_abuse']} headingLevel="h3" />
            </section>
            {session && (
                <section aria-labelledby="worker-title" className="flex flex-col gap-3">
                    <h2 id="worker-title" className="text-2xl font-bold">
                        {ts.requestTitle}
                    </h2>
                    <p>{ts.homeSupportText}</p>
                    <Link to="/parler-a-une-intervenante" className={buttonClass('secondary', 'self-start')}>
                        {ts.distressAsk}
                    </Link>
                </section>
            )}
        </div>
    );
}
