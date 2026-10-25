import { fr } from '../../i18n/fr';
import type { ConsentText, ConsentTextType } from '../../lib/consents';

/** Texte complet d'un consentement, replié par défaut pour garder la page lisible sur téléphone. */
export function ConsentTextDetails({ text, open = false }: { text: ConsentText<ConsentTextType>; open?: boolean }) {
    return (
        <details open={open} className="rounded-lg bg-canvas p-3">
            <summary className="font-bold text-brand">{fr.consents.readFull}</summary>
            <div className="mt-3 flex flex-col gap-3">
                {text.sections.map((section) => (
                    <div key={section.heading}>
                        <h3 className="font-bold">{section.heading}</h3>
                        <p>{section.text}</p>
                    </div>
                ))}
            </div>
        </details>
    );
}
