import { useParams } from 'react-router';
import { Button, Loading, PageTitle } from '../../components/ui';
import { documents as td } from '../../i18n/documents.fr';
import { files as tf } from '../../i18n/files.fr';
import { consentText } from '../../lib/consents';
import { formatDate } from '../../lib/format';
import { useCareFile } from './useFile';

/** Formulaire imprimable : le texte de consentement et les lignes de signature, rien d'autre. */
export function ConsentFormPage() {
    const { fileId = '' } = useParams();
    const file = useCareFile(fileId);
    const text = consentText('care_recipient_data');
    const ai = consentText('ai_document_processing');
    if (file.isPending) return <Loading />;

    return (
        <article className="flex flex-col gap-4">
            <PageTitle>{tf.formTitle}</PageTitle>
            {file.data && <p className="text-muted">{tf.formFor(file.data.title)}</p>}
            <h2 className="text-xl font-bold">{text.title}</h2>
            <p>{text.summary}</p>
            {text.sections.map((section) => (
                <section key={section.heading}>
                    <h3 className="font-bold">{section.heading}</h3>
                    <p>{section.text}</p>
                </section>
            ))}
            <dl className="mt-4 flex flex-col gap-6">
                {[tf.formPersonName, tf.formSignature, tf.formDate, tf.formRepresentative].map((label) => (
                    <div key={label}>
                        <dt className="font-bold">{label}</dt>
                        <dd className="mt-8 border-b-2 border-ink" aria-hidden="true" />
                    </div>
                ))}
            </dl>
            <p className="text-muted">{tf.formVersion(formatDate(text.version))}</p>

            {/* Consentement distinct et facultatif : un choix explicite, séparé du premier. */}
            <section aria-labelledby="form-ai" className="mt-6 flex flex-col gap-3 border-t-2 border-ink pt-6">
                <h2 id="form-ai" className="text-xl font-bold">
                    {td.formAiTitle}
                </h2>
                <p>{ai.summary}</p>
                {ai.sections.map((section) => (
                    <section key={section.heading}>
                        <h3 className="font-bold">{section.heading}</h3>
                        <p>{section.text}</p>
                    </section>
                ))}
                <p className="font-bold">{td.formAiChoice}</p>
                <p aria-hidden="true">
                    ☐ {td.formAiYes} &nbsp;&nbsp; ☐ {td.formAiNo}
                </p>
                <p className="sr-only">{`${td.formAiYes} / ${td.formAiNo}`}</p>
                <dl className="flex flex-col gap-6">
                    {[tf.formSignature, tf.formDate].map((label) => (
                        <div key={label}>
                            <dt className="font-bold">{label}</dt>
                            <dd className="mt-8 border-b-2 border-ink" aria-hidden="true" />
                        </div>
                    ))}
                </dl>
                <p className="text-muted">{tf.formVersion(formatDate(ai.version))}</p>
            </section>
            <Button className="no-print" onClick={() => window.print()}>
                {tf.formPrint}
            </Button>
        </article>
    );
}
