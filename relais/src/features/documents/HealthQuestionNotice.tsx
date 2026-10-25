import { useHelpResources } from '../../app/queries';
import { buttonClass } from '../../components/ui';
import { documents as td } from '../../i18n/documents.fr';
import { dialable, formatPhone } from '../../lib/format';

/**
 * Rappel fixe : Relais ne donne aucun conseil médical (règle no 1). Le numéro vient de la table des
 * ressources (ou de sa copie de secours), jamais d'un texte généré.
 */
export function HealthQuestionNotice({ short = false }: { short?: boolean }) {
    const resources = useHelpResources();
    const infoSante = resources.find((r) => r.slug === 'info-sante-811');
    return (
        <div role="note" className="flex flex-col gap-3 rounded-lg border-2 border-line bg-surface p-4">
            <p>{short ? td.noAdviceShort : td.noAdvice}</p>
            {infoSante?.phone && (
                <a href={`tel:${dialable(infoSante.phone)}`} className={buttonClass('secondary', 'self-start')}>
                    {td.callInfoSante(formatPhone(infoSante.phone))}
                </a>
            )}
        </div>
    );
}
