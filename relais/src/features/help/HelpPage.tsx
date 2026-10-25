import { useHelpResources } from '../../app/queries';
import { Notice, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { HelpResourceList } from './HelpResourceList';

/** Page publique, accessible sans connexion depuis l'en-tête de chaque page. */
export function HelpPage() {
    const resources = useHelpResources();
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
        </div>
    );
}
