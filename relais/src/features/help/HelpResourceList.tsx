import { buttonClass } from '../../components/ui';
import { fr } from '../../i18n/fr';
import type { Resource } from '../../lib/api';
import { dialable, formatPhone } from '../../lib/format';

type Category = Resource['category'];

/** Liste de ressources, triée selon l'ordre de catégories demandé puis l'ordre de la table. */
export function HelpResourceList({
    resources,
    categories,
    headingLevel = 'h2'
}: {
    resources: Resource[];
    categories: readonly Category[];
    headingLevel?: 'h2' | 'h3';
}) {
    const rank = (c: Category) => categories.indexOf(c);
    const shown = resources
        .filter((r) => categories.includes(r.category))
        .sort((a, b) => rank(a.category) - rank(b.category) || a.sort_order - b.sort_order);
    const Heading = headingLevel;

    return (
        <ul className="flex list-none flex-col gap-3 p-0">
            {shown.map((resource) => (
                <li
                    key={resource.slug}
                    className={`rounded-xl border-2 bg-surface p-4 ${resource.category === 'emergency' ? 'border-urgent' : 'border-line'}`}
                >
                    <Heading className="text-xl font-bold">{resource.name}</Heading>
                    {resource.description && <p className="mt-1">{resource.description}</p>}
                    {resource.hours && (
                        <p className="mt-1 text-muted">
                            {fr.help.hours} {resource.hours}
                        </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                        {resource.phone && (
                            <a
                                href={`tel:${dialable(resource.phone)}`}
                                className={buttonClass(resource.category === 'emergency' ? 'danger' : 'primary')}
                            >
                                {fr.help.call(formatPhone(resource.phone))}
                            </a>
                        )}
                        {resource.sms && (
                            <a href={`sms:${dialable(resource.sms)}`} className={buttonClass('secondary')}>
                                {fr.help.text(formatPhone(resource.sms))}
                            </a>
                        )}
                        {resource.url && !resource.phone && (
                            <a href={resource.url} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary')}>
                                {fr.help.website(resource.name)}
                            </a>
                        )}
                    </div>
                </li>
            ))}
        </ul>
    );
}
