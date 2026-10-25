import { useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { buttonClass, Card, Loading, Notice, PageTitle } from '../../components/ui';
import { DOCUMENT_STATUS_LABELS, documents as td } from '../../i18n/documents.fr';
import { ACCEPTED_MIME_TYPES, extractDocument, MAX_UPLOAD_BYTES, uploadDocument, type CareDocument } from '../../lib/documents';
import { formatDate } from '../../lib/format';
import { prepareImage, UnsupportedImageError } from '../../lib/image';
import { DOCUMENT_TYPE_LABELS } from '../../shared/extraction/labels.fr';
import { useFileContext } from '../files/FileLayout';
import { docKeys, useAiConsent, useDocuments } from './useDocuments';

type Phase = 'idle' | 'preparing' | 'uploading' | 'reading';

export function documentTitle(doc: CareDocument): string {
    return doc.title ?? (doc.doc_type ? DOCUMENT_TYPE_LABELS[doc.doc_type] : td.untitled(formatDate(doc.uploaded_at)));
}

/** Liste des documents du dossier et ajout (photo ou fichier). */
export function FileDocumentsPage() {
    const { file, access } = useFileContext();
    const list = useDocuments(file.id);
    const ai = useAiConsent(file.id);
    const canWrite = access.canWrite('health');
    const level = access.membership?.access_level;
    const isOwner = level === 'owner';
    // Accès en écriture, mais sans son propre consentement « Renseignements de santé ».
    const needsHealthConsent = (level === 'owner' || level === 'full') && !access.myHealthConsent;

    if (list.isPending || ai.isPending) return <Loading />;
    const docs = list.data ?? [];

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{td.title}</PageTitle>
            <p>{td.intro}</p>
            {access.recipientConsent && (
                <Notice tone="info">
                    <p>{ai.active ? td.aiOn : td.aiOff}</p>
                    {!ai.active && isOwner && (
                        <Link to="../consentement" relative="path" className={buttonClass('secondary', 'mt-3')}>
                            {td.aiOffOwner}
                        </Link>
                    )}
                </Notice>
            )}

            {canWrite && <UploadSection fileId={file.id} aiActive={Boolean(ai.active)} />}
            {!canWrite && access.recipientConsent && <p className="text-muted">{needsHealthConsent ? td.noHealthConsent : td.readOnly}</p>}

            <section aria-labelledby="documents-list" className="flex flex-col gap-3">
                <h2 id="documents-list" className="text-xl font-bold">
                    {docs.length === 0 ? td.noDocuments : td.title}
                </h2>
                <ul className="flex list-none flex-col gap-3 p-0">
                    {docs.map((doc) => (
                        <li key={doc.id}>
                            <Card className="flex flex-col gap-1">
                                <Link to={doc.id} className="text-lg font-bold text-brand underline underline-offset-4">
                                    {documentTitle(doc)}
                                </Link>
                                <p className="text-muted">
                                    {[
                                        doc.doc_date ? formatDate(doc.doc_date) : formatDate(doc.uploaded_at),
                                        doc.mime_type === 'application/pdf' ? (doc.page_count ? td.pages(doc.page_count) : 'PDF') : td.photo
                                    ].join(' · ')}
                                </p>
                                <p className="flex flex-wrap gap-2">
                                    <span className="rounded-md bg-brand-soft px-2 py-1 font-bold text-brand">
                                        {DOCUMENT_STATUS_LABELS[doc.status]}
                                    </span>
                                    {doc.needs_review && (
                                        <span className="rounded-md bg-urgent-soft px-2 py-1 font-bold text-urgent">{td.toCheck}</span>
                                    )}
                                </p>
                            </Card>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}

const fileInputLabel =
    'focus-within:outline focus-within:outline-4 focus-within:outline-offset-2 focus-within:outline-focus cursor-pointer';

function UploadSection({ fileId, aiActive }: { fileId: string; aiActive: boolean }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [phase, setPhase] = useState<Phase>('idle');
    const [error, setError] = useState<string | null>(null);

    async function handle(event: ChangeEvent<HTMLInputElement>) {
        const selected = event.target.files?.[0];
        event.target.value = '';
        if (!selected) return;
        setError(null);
        if (selected.size > MAX_UPLOAD_BYTES) return setError(td.tooBig);

        let body: Blob = selected;
        let mimeType: (typeof ACCEPTED_MIME_TYPES)[number];
        try {
            if (selected.type === 'application/pdf') {
                mimeType = 'application/pdf';
            } else if (selected.type.startsWith('image/')) {
                setPhase('preparing');
                body = await prepareImage(selected);
                mimeType = 'image/jpeg';
            } else {
                return setError(td.badType);
            }
        } catch (err) {
            setPhase('idle');
            return setError(err instanceof UnsupportedImageError ? td.badImage : td.uploadError);
        }

        let documentId: string;
        try {
            setPhase('uploading');
            documentId = await uploadDocument(fileId, body, mimeType);
        } catch {
            setPhase('idle');
            await queryClient.invalidateQueries({ queryKey: docKeys.list(fileId) });
            return setError(td.uploadError);
        }
        if (aiActive && mimeType === 'application/pdf') {
            setPhase('reading');
            // Le résultat (brouillon ou raison de l'échec) s'affiche sur la page du document.
            await extractDocument(documentId).catch(() => undefined);
        }
        await queryClient.invalidateQueries({ queryKey: docKeys.list(fileId) });
        navigate(`/dossiers/${fileId}/documents/${documentId}`);
    }

    const busy = phase !== 'idle';
    return (
        <section aria-labelledby="add-document" className="flex flex-col gap-3">
            <h2 id="add-document" className="text-xl font-bold">
                {td.addTitle}
            </h2>
            <p className="text-muted">{td.addHint}</p>
            {busy ? (
                <p role="status" className="font-bold">
                    {phase === 'preparing' ? td.preparing : phase === 'uploading' ? td.uploading : td.reading}
                </p>
            ) : (
                <div className="flex flex-col gap-3 sm:flex-row">
                    <label className={buttonClass('primary', fileInputLabel)}>
                        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void handle(e)} />
                        {td.takePhoto}
                    </label>
                    <label className={buttonClass('secondary', fileInputLabel)}>
                        <input type="file" accept={ACCEPTED_MIME_TYPES.join(',')} className="sr-only" onChange={(e) => void handle(e)} />
                        {td.chooseFile}
                    </label>
                </div>
            )}
            {error && <Notice tone="error">{error}</Notice>}
        </section>
    );
}
