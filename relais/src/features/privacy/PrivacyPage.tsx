import { PageTitle } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { consentText } from '../../lib/consents';
import { fr } from '../../i18n/fr';

/** Politique de confidentialité publiée, lisible avant toute création de compte. */
export function PrivacyPage() {
    const text = consentText('privacy_policy');
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{text.title}</PageTitle>
            <p className="text-xl">{text.summary}</p>
            {text.sections.map((section) => (
                <section key={section.heading}>
                    <h2 className="text-xl font-bold">{section.heading}</h2>
                    <p className="mt-1">{section.text}</p>
                </section>
            ))}
            <p className="text-muted">
                {fr.privacy.title} — {fr.consents.versionOf(formatDate(text.version))}
            </p>
        </div>
    );
}
