// Pipeline d'extraction d'un document (fonction `extract-document`).
//
//   1. start (jeton de l'utilisateur) : droits d'écriture santé + consentement de lecture automatique
//   2. lecture du fichier (clé serveur) → texte du PDF, ou OCR (Q3) ; sinon saisie à la main
//   3. pseudonymisation (dictionnaire du dossier + motifs) — la table reste en mémoire
//   4. appel au modèle (texte pseudonymisé seulement), sortie validée par Zod
//   5. garde-fous + ré-identification locale → brouillon validé → save (draft_ready)
//   6. ai_calls : métadonnées seulement (statut, jetons, durée, compteurs de pseudonymisation)
// Toute erreur après le début remet le document en état « failed » avec un code, jamais en suspens.
import { guardAndRestore } from '../../../src/shared/extraction/guards.ts';
import { draftSchema, type ExtractionDraft } from '../../../src/shared/extraction/schema.ts';
import { hasResidualIdentifiers, pseudonymize, type PseudonymCategory } from '../../../src/shared/pseudonymize/pseudonymize.ts';
import type { LlmClient, LlmStatus } from './llm.ts';
import { serverLog } from './log.ts';
import { OCR_CONFIDENCE_THRESHOLD, type OcrClient } from './ocr.ts';
import { readPdfText } from './pdf.ts';

export const MAX_PAGES_READ = 30;
export const MAX_CHARS_READ = 60_000;
/** En dessous de ce nombre moyen de caractères par page, le PDF est une image numérisée. */
const MIN_CHARS_PER_PAGE = 40;

export type ExtractionErrorCode =
    'no_text_layer' | 'photo_without_ocr' | 'too_long' | 'unreadable_pdf' | 'refusal' | 'invalid_output' | 'ai_unavailable';

export interface ExtractionStart {
    care_file_id: string;
    storage_path: string;
    mime_type: string;
    persons: string[];
    addresses: string[];
}

export interface AiCallRow {
    user_id: string;
    /** Null pour une explication ou une lettre (tirées de la fiche seule, sans dossier). */
    care_file_id: string | null;
    purpose: 'document_extraction' | 'program_explanation' | 'letter_draft';
    provider: string;
    model: string;
    status: LlmStatus | 'guard_flagged';
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number;
    pseudonymized_counts: Partial<Record<PseudonymCategory, number>>;
}

export interface SaveExtraction {
    documentId: string;
    actorId: string;
    draft: ExtractionDraft;
    pageCount: number | null;
}

/** Accès aux données et aux fichiers, fournis par la fonction Deno (ou par les tests). */
export interface ExtractionPorts {
    start(documentId: string): Promise<ExtractionStart>;
    download(path: string): Promise<Uint8Array>;
    save(input: SaveExtraction): Promise<string | null>;
    fail(documentId: string, code: ExtractionErrorCode, pageCount: number | null): Promise<void>;
    recordAiCall(row: AiCallRow): Promise<void>;
}

export interface ExtractionDeps extends ExtractionPorts {
    llm: LlmClient | null;
    ocr: OcrClient | null;
    now?: () => number;
}

export type ExtractionResult =
    { status: 'draft_ready'; extractionId: string | null; draft: ExtractionDraft } | { status: 'failed'; code: ExtractionErrorCode };

class ExtractionFailure extends Error {
    readonly code: ExtractionErrorCode;
    constructor(code: ExtractionErrorCode) {
        super(code);
        this.code = code;
    }
}

interface DocumentText {
    text: string;
    pageCount: number | null;
    lowConfidence: boolean;
}

async function documentText(deps: ExtractionDeps, bytes: Uint8Array, mimeType: string): Promise<DocumentText> {
    if (mimeType === 'application/pdf') {
        let pdf;
        try {
            pdf = await readPdfText(bytes);
        } catch {
            throw new ExtractionFailure('unreadable_pdf');
        }
        if (pdf.pageCount > MAX_PAGES_READ) throw new ExtractionFailure('too_long');
        const text = pdf.pages.map((page, i) => `--- Page ${i + 1} ---\n${page}`).join('\n\n');
        const chars = pdf.pages.reduce((sum, page) => sum + page.replace(/\s/g, '').length, 0);
        if (chars >= MIN_CHARS_PER_PAGE * pdf.pageCount) return { text, pageCount: pdf.pageCount, lowConfidence: false };
        if (!deps.ocr) throw new ExtractionFailure('no_text_layer');
        const ocr = await deps.ocr.recognize(bytes, mimeType);
        return { text: ocr.text, pageCount: pdf.pageCount, lowConfidence: ocr.confidence < OCR_CONFIDENCE_THRESHOLD };
    }
    if (!deps.ocr) throw new ExtractionFailure('photo_without_ocr');
    const ocr = await deps.ocr.recognize(bytes, mimeType);
    return { text: ocr.text, pageCount: 1, lowConfidence: ocr.confidence < OCR_CONFIDENCE_THRESHOLD };
}

/**
 * Lit un document et en enregistre le brouillon. Les erreurs de `start` (droits, consentement, état)
 * sont relancées telles quelles ; toutes les autres finissent en « failed » avec un code.
 */
export async function extractDocument(deps: ExtractionDeps, documentId: string, actorId: string): Promise<ExtractionResult> {
    const now = deps.now ?? (() => Date.now());
    const startedAt = now();
    const started = await deps.start(documentId);
    let pageCount: number | null = null;

    try {
        const bytes = await deps.download(started.storage_path);
        const read = await documentText(deps, bytes, started.mime_type);
        pageCount = read.pageCount;
        if (read.text.length > MAX_CHARS_READ) throw new ExtractionFailure('too_long');
        if (read.text.replace(/\s/g, '').length === 0) throw new ExtractionFailure('no_text_layer');

        const pseudo = pseudonymize(read.text, { persons: started.persons, addresses: started.addresses });
        // Filet de sécurité : aucun identifiant fort ne doit subsister dans ce qui part.
        if (hasResidualIdentifiers(pseudo.text)) throw new ExtractionFailure('invalid_output');
        if (!deps.llm) throw new ExtractionFailure('ai_unavailable');

        const callStart = now();
        const result = await deps.llm.extractDocument({ text: pseudo.text, pageCount: read.pageCount ?? 1 });
        const aiCall: AiCallRow = {
            user_id: actorId,
            care_file_id: started.care_file_id,
            purpose: 'document_extraction',
            provider: deps.llm.provider,
            model: result.model,
            status: result.status,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            latency_ms: Math.max(0, Math.round(now() - callStart)),
            pseudonymized_counts: pseudo.counts
        };

        if (result.status !== 'ok' || !result.output) {
            await deps.recordAiCall(aiCall);
            throw new ExtractionFailure(
                result.status === 'refusal' ? 'refusal' : result.status === 'schema_error' ? 'invalid_output' : 'ai_unavailable'
            );
        }

        const guarded = guardAndRestore(result.output, pseudo.text, pseudo.mapping);
        if (read.lowConfidence) {
            guarded.draft.needs_review = true;
            if (!guarded.draft.review_reasons.includes('blurry')) guarded.draft.review_reasons.push('blurry');
        }
        await deps.recordAiCall({ ...aiCall, status: guarded.flagged ? 'guard_flagged' : 'ok' });

        const draft = draftSchema.safeParse(guarded.draft);
        if (!draft.success) throw new ExtractionFailure('invalid_output');

        const extractionId = await deps.save({ documentId, actorId, draft: draft.data, pageCount });
        serverLog('extraction_completed', { durationMs: Math.round(now() - startedAt), count: read.pageCount ?? 1 });
        return { status: 'draft_ready', extractionId, draft: draft.data };
    } catch (error) {
        const code = error instanceof ExtractionFailure ? error.code : 'ai_unavailable';
        serverLog('extraction_failed', {
            code,
            errorName: error instanceof Error ? error.name : 'unknown',
            durationMs: Math.round(now() - startedAt)
        });
        await deps.fail(documentId, code, pageCount);
        return { status: 'failed', code };
    }
}
