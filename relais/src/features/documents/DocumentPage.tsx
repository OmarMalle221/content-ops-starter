import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button, buttonClass, Card, Loading, Notice, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { DOCUMENT_STATUS_LABELS, EXTRACTION_ERROR_LABELS, RETRYABLE_ERRORS, documents as td } from '../../i18n/documents.fr';
import { ApiError } from '../../lib/api';
import {
    deleteDocument,
    documentUrl,
    extractDocument,
    logExtractionViewed,
    type CareDocument,
    type ConfirmedData,
    type Extraction
} from '../../lib/documents';
import { formatDate } from '../../lib/format';
import { DOCUMENT_TYPE_LABELS, TIMELINE_EVENT_LABELS } from '../../shared/extraction/labels.fr';
import { useFileContext } from '../files/FileLayout';
import { fileKeys } from '../files/useFile';
import { documentTitle } from './FileDocumentsPage';
import { HealthQuestionNotice } from './HealthQuestionNotice';
import { ReviewForm } from './ReviewForm';
import { docKeys, useAiConsent, useDocument, useExtraction } from './useDocuments';

type Status = { tone: 'success' | 'error' | 'info'; text: string } | null;

export function DocumentPage() {
    const { documentId = '' } = useParams();
    const { file, access } = useFileContext();
    const document = useDocument(documentId);
    const doc = document.data;
    const hasExtraction = doc?.status === 'draft_ready' || doc?.status === 'confirmed';
    const extraction = useExtraction(documentId, hasExtraction);
    const ai = useAiConsent(file.id);
    const canWrite = access.canWrite('health');
    const [status, setStatus] = useState<Status>(null);
    const [manual, setManual] = useState(false);
    const logged = useRef<string | null>(null);

    // Journal : consultation d'un brouillon ou d'un résumé confirmé, une fois par document affiché.
    const viewed = Boolean(extraction.data);
    useEffect(() => {
        if (!viewed || logged.current === documentId) return;
        logged.current = documentId;
        void logExtractionViewed(file.id, documentId).catch(() => undefined);
    }, [viewed, file.id, documentId]);

    if (document.isPending || (hasExtraction && extraction.isPending) || ai.isPending) return <Loading />;
    if (!doc) {
        return (
            <div className="flex flex-col gap-4">
                <Notice tone="error">{td.notFound}</Notice>
                <Link to=".." relative="path" className={buttonClass('secondary')}>
                    {td.backToList}
                </Link>
            </div>
        );
    }

    const onDone = (message: string) => {
        setManual(false);
        setStatus({ tone: 'success', text: message });
    };

    return (
        <div className="flex flex-col gap-5">
            <Link to=".." relative="path" className="self-start font-bold text-brand underline underline-offset-4">
                {td.backToList}
            </Link>
            <PageTitle>{documentTitle(doc)}</PageTitle>
            <p className="flex flex-wrap gap-2">
                <span className="rounded-md bg-brand-soft px-2 py-1 font-bold text-brand">{DOCUMENT_STATUS_LABELS[doc.status]}</span>
                {doc.needs_review && <span className="rounded-md bg-urgent-soft px-2 py-1 font-bold text-urgent">{td.toCheck}</span>}
            </p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <OriginalLink documentId={doc.id} pending={doc.status === 'pending_upload'} />

            {manual ? (
                <ReviewForm document={doc} extraction={null} onDone={onDone} />
            ) : (
                <DocumentBody
                    doc={doc}
                    extraction={extraction.data ?? null}
                    canWrite={canWrite}
                    aiActive={Boolean(ai.active)}
                    onManual={() => setManual(true)}
                    onDone={onDone}
                    onStatus={setStatus}
                />
            )}

            {canWrite && <DeleteDocument doc={doc} />}
        </div>
    );
}

function DocumentBody({
    doc,
    extraction,
    canWrite,
    aiActive,
    onManual,
    onDone,
    onStatus
}: {
    doc: CareDocument;
    extraction: Extraction | null;
    canWrite: boolean;
    aiActive: boolean;
    onManual: () => void;
    onDone: (message: string) => void;
    onStatus: (status: Status) => void;
}) {
    const queryClient = useQueryClient();
    const [reading, setReading] = useState(false);

    async function read() {
        setReading(true);
        onStatus(null);
        try {
            await extractDocument(doc.id);
        } catch (error) {
            const code = error instanceof ApiError ? error.code : undefined;
            onStatus({
                tone: 'error',
                text: code && code in EXTRACTION_ERROR_LABELS ? EXTRACTION_ERROR_LABELS[code]! : fr.app.genericError
            });
        } finally {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: docKeys.document(doc.id) }),
                queryClient.invalidateQueries({ queryKey: docKeys.list(doc.care_file_id) })
            ]);
            setReading(false);
        }
    }

    if (reading || doc.status === 'processing') {
        return (
            <p role="status" className="font-bold">
                {td.reading}
            </p>
        );
    }

    if (doc.status === 'confirmed' && extraction?.confirmed) {
        return <ConfirmedView doc={doc} extraction={extraction} confirmed={extraction.confirmed} />;
    }

    if (doc.status === 'draft_ready' && extraction) {
        return canWrite ? (
            <ReviewForm document={doc} extraction={extraction} onDone={onDone} />
        ) : (
            <Notice tone="info">{td.waitingForFamily}</Notice>
        );
    }

    if (doc.status === 'pending_upload') return <Notice tone="info">{td.pendingUpload}</Notice>;

    // « À lire » ou lecture impossible : raison, nouvel essai si utile, saisie à la main.
    const isPhoto = doc.mime_type !== 'application/pdf';
    const reason = doc.extraction_error ?? (isPhoto ? 'photo_without_ocr' : aiActive ? null : 'ai_consent_missing');
    const canRead = aiActive && !isPhoto && (doc.status === 'uploaded' || (reason !== null && RETRYABLE_ERRORS.has(reason)));
    return (
        <Card className="flex flex-col gap-3">
            <p>{reason ? EXTRACTION_ERROR_LABELS[reason] : td.toRead}</p>
            {!canWrite && <p className="text-muted">{td.waitingForFamily}</p>}
            {canWrite && (
                <div className="flex flex-col gap-3 sm:flex-row">
                    {canRead && <Button onClick={() => void read()}>{doc.status === 'failed' ? td.readAgain : td.readAuto}</Button>}
                    <Button variant={canRead ? 'secondary' : 'primary'} onClick={onManual}>
                        {td.enterManually}
                    </Button>
                </div>
            )}
        </Card>
    );
}

function ConfirmedView({ doc, extraction, confirmed }: { doc: CareDocument; extraction: Extraction; confirmed: ConfirmedData }) {
    const nothing =
        !confirmed.summary &&
        confirmed.medications.length === 0 &&
        confirmed.timeline_events.length === 0 &&
        confirmed.action_items.length === 0;
    return (
        <section aria-labelledby="confirmed-title" className="flex flex-col gap-4">
            <h2 id="confirmed-title" className="text-2xl font-bold">
                {td.confirmedTitle}
            </h2>
            <dl className="grid gap-1">
                {doc.doc_type && (
                    <>
                        <dt className="font-bold">{td.docType}</dt>
                        <dd>{DOCUMENT_TYPE_LABELS[doc.doc_type]}</dd>
                    </>
                )}
                {doc.doc_date && (
                    <>
                        <dt className="font-bold">{td.eventDate}</dt>
                        <dd>{formatDate(doc.doc_date)}</dd>
                    </>
                )}
                {doc.author && (
                    <>
                        <dt className="font-bold">{td.docAuthor.replace(' (facultatif)', '')}</dt>
                        <dd>{doc.author}</dd>
                    </>
                )}
            </dl>
            {confirmed.summary && <p className="rounded-lg bg-surface p-4">{confirmed.summary}</p>}
            {nothing && <p className="text-muted">{td.nothingKept}</p>}

            {confirmed.medications.length > 0 && (
                <>
                    <h3 className="text-xl font-bold">{td.medicationsSection}</h3>
                    <ul className="list-disc pl-5">
                        {confirmed.medications.map((m, i) => (
                            <li key={i}>{[m.name, m.dosage, m.frequency].filter(Boolean).join(' — ')}</li>
                        ))}
                    </ul>
                    <HealthQuestionNotice short />
                </>
            )}
            {confirmed.timeline_events.length > 0 && (
                <>
                    <h3 className="text-xl font-bold">{td.eventsSection}</h3>
                    <ul className="list-disc pl-5">
                        {confirmed.timeline_events.map((e, i) => (
                            <li key={i}>
                                {formatDate(e.occurred_on)} — {TIMELINE_EVENT_LABELS[e.event_type]} : {e.title}
                                {e.description ? ` (${e.description})` : ''}
                            </li>
                        ))}
                    </ul>
                    <Link to="../../chronologie" relative="path" className={buttonClass('secondary', 'self-start')}>
                        {td.seeTimeline}
                    </Link>
                </>
            )}
            {confirmed.action_items.length > 0 && (
                <>
                    <h3 className="text-xl font-bold">{td.actionsSection}</h3>
                    <ul className="list-disc pl-5">
                        {confirmed.action_items.map((a, i) => (
                            <li key={i}>{a.text}</li>
                        ))}
                    </ul>
                </>
            )}
            <p className="text-muted">
                {extraction.method === 'manual' ? `${td.manualEntry} ` : ''}
                {extraction.confirmedAt ? td.confirmedOn(formatDate(extraction.confirmedAt)) : ''}
            </p>
        </section>
    );
}

/** Lien signé de 60 secondes, demandé au moment voulu (la consultation est journalisée). */
function OriginalLink({ documentId, pending }: { documentId: string; pending: boolean }) {
    const [url, setUrl] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    if (pending) return null;

    async function prepare() {
        setBusy(true);
        setError(false);
        try {
            setUrl(await documentUrl(documentId));
            // Le lien expire : on le retire avant la fin de sa validité.
            window.setTimeout(() => setUrl(null), 50_000);
        } catch {
            setError(true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-2">
            {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClass('secondary', 'self-start')}>
                    {td.originalReady}
                </a>
            ) : (
                <Button variant="secondary" className="self-start" disabled={busy} onClick={() => void prepare()}>
                    {busy ? td.openingOriginal : td.openOriginal}
                </Button>
            )}
            {error && <Notice tone="error">{td.originalError}</Notice>}
        </div>
    );
}

function DeleteDocument({ doc }: { doc: CareDocument }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);

    async function remove() {
        setBusy(true);
        try {
            await deleteDocument(doc.id);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: docKeys.list(doc.care_file_id) }),
                queryClient.invalidateQueries({ queryKey: docKeys.timeline(doc.care_file_id) }),
                queryClient.invalidateQueries({ queryKey: docKeys.medications(doc.care_file_id) }),
                queryClient.invalidateQueries({ queryKey: fileKeys.log(doc.care_file_id) })
            ]);
            queryClient.removeQueries({ queryKey: docKeys.document(doc.id) });
            navigate(`/dossiers/${doc.care_file_id}/documents`, { state: { notice: td.deleted } });
        } catch {
            setError(true);
            setBusy(false);
        }
    }

    if (!confirming) {
        return (
            <Button variant="quiet" className="self-start" onClick={() => setConfirming(true)}>
                {td.deleteDocument}
            </Button>
        );
    }
    return (
        <div role="group" aria-labelledby="delete-document" className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4">
            <p id="delete-document" className="font-bold">
                {td.confirmDelete}
            </p>
            {error && <Notice tone="error">{fr.app.genericError}</Notice>}
            <div className="flex flex-wrap gap-2">
                <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                    {td.deleteConfirm}
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                    {td.cancel}
                </Button>
            </div>
        </div>
    );
}
