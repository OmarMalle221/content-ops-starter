// Fonctions serveur, indépendantes de Deno : la même logique tourne dans les fonctions Edge
// (deno-server.ts), dans le faux Supabase des tests de bout en bout et dans les tests Vitest.
//
//   extract-document   : lecture automatique d'un document → brouillon
//   get-document-url   : seule voie de lecture d'un fichier (accès vérifié et journalisé, URL de 60 s)
//   delete-document    : suppression du document puis de son fichier dans Storage
//   delete-care-file   : suppression du dossier puis de tous ses fichiers dans Storage
//   explain-program    : explication d'un programme tirée de la seule fiche (cache par version)
//   draft-letter       : modèle de lettre à espaces réservés, tiré de la seule fiche (cache par version)
import { z } from 'zod';
import {
    explanationOutputSchema,
    ficheFromProgram,
    guardExplanation,
    guardLetter,
    LETTER_KINDS,
    type ProgramFiche
} from '../../../src/shared/benefits/ai.ts';
import { criteriaSchema } from '../../../src/shared/benefits/engine.ts';
import { EXTRACTION_SCHEMA_VERSION } from '../../../src/shared/extraction/schema.ts';
import { extractDocument, type AiCallRow, type ExtractionErrorCode, type ExtractionStart } from './extract.ts';
import type { LlmClient, LlmResult } from './llm.ts';
import { serverLog } from './log.ts';
import type { OcrClient } from './ocr.ts';

export const DOCUMENTS_BUCKET = 'documents';
export const SIGNED_URL_SECONDS = 60;

/** Erreur d'un appel à la base, réduite à son code SQLSTATE (jamais le message). */
export class RpcError extends Error {
    readonly code: string;
    constructor(code: string) {
        super(`rpc error ${code}`);
        this.name = 'RpcError';
        this.code = code;
    }
}

export interface ServerContext {
    userId: string;
    /** Appel sous l'identité de l'utilisateur (RLS et contrôles des fonctions SQL). */
    userRpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
    /** Appel avec la clé serveur (fonctions réservées au rôle service). */
    serviceRpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
    storage: {
        download(path: string): Promise<Uint8Array>;
        remove(paths: string[]): Promise<void>;
        signedUrl(path: string, expiresInSeconds: number): Promise<string>;
    };
    /** Chemins inscrits pour effacement sous un préfixe (« {care_file_id}/ »). */
    queuedPaths(prefix: string): Promise<string[]>;
    clearQueuedPaths(paths: string[]): Promise<void>;
    recordAiCall(row: AiCallRow): Promise<void>;
    llm: LlmClient | null;
    ocr: OcrClient | null;
}

export interface HandlerResponse {
    status: number;
    body: Record<string, unknown>;
}

export type Handler = (ctx: ServerContext, body: unknown) => Promise<HandlerResponse>;

const documentRequest = z.object({ document_id: z.uuid() });
const careFileRequest = z.object({ care_file_id: z.uuid() });

const badRequest: HandlerResponse = { status: 400, body: { error: 'bad_request' } };

/** Codes SQLSTATE des fonctions SQL → réponse HTTP sans détail. */
function fromRpcError(error: unknown): HandlerResponse {
    const code = error instanceof RpcError ? error.code : 'internal';
    switch (code) {
        case 'RLA01':
            return { status: 403, body: { error: 'ai_consent_missing' } };
        case 'RLA02':
            return { status: 409, body: { error: 'document_state' } };
        case '42501':
            return { status: 403, body: { error: 'forbidden' } };
        case '22023':
        case '22P02':
            return badRequest;
        default:
            serverLog('function_error', { code, errorName: error instanceof Error ? error.name : 'unknown' });
            return { status: 500, body: { error: 'internal' } };
    }
}

/** Efface des fichiers de Storage ; s'ils restent, la file d'effacement permet de reprendre plus tard. */
async function purgeStorage(ctx: ServerContext, paths: string[]): Promise<boolean> {
    if (paths.length === 0) return true;
    try {
        await ctx.storage.remove(paths);
        await ctx.clearQueuedPaths(paths);
        return true;
    } catch (error) {
        serverLog('storage_purge_failed', { count: paths.length, errorName: error instanceof Error ? error.name : 'unknown' });
        return false;
    }
}

export const handleExtractDocument: Handler = async (ctx, body) => {
    const request = documentRequest.safeParse(body);
    if (!request.success) return badRequest;
    const documentId = request.data.document_id;
    try {
        const result = await extractDocument(
            {
                llm: ctx.llm,
                ocr: ctx.ocr,
                start: (id) => ctx.userRpc<ExtractionStart>('start_document_extraction', { p_document_id: id }),
                download: (path) => ctx.storage.download(path),
                save: ({ draft, pageCount, actorId }) =>
                    ctx.serviceRpc<string | null>('save_document_extraction', {
                        p_document_id: documentId,
                        p_actor_id: actorId,
                        p_draft: draft,
                        p_schema_version: EXTRACTION_SCHEMA_VERSION,
                        p_legibility: draft.legibility,
                        p_needs_review: draft.needs_review,
                        p_review_reasons: draft.review_reasons,
                        p_guard_flags: draft.guard_flags,
                        p_page_count: pageCount
                    }),
                fail: (id, code: ExtractionErrorCode, pageCount) =>
                    ctx.serviceRpc<void>('fail_document_extraction', { p_document_id: id, p_code: code, p_page_count: pageCount }),
                recordAiCall: (row) => ctx.recordAiCall(row)
            },
            documentId,
            ctx.userId
        );
        return result.status === 'draft_ready'
            ? { status: 200, body: { status: 'draft_ready', extraction_id: result.extractionId } }
            : { status: 200, body: { status: 'failed', code: result.code } };
    } catch (error) {
        return fromRpcError(error);
    }
};

export const handleDocumentUrl: Handler = async (ctx, body) => {
    const request = documentRequest.safeParse(body);
    if (!request.success) return badRequest;
    try {
        const path = await ctx.userRpc<string>('authorize_document_download', { p_document_id: request.data.document_id });
        const url = await ctx.storage.signedUrl(path, SIGNED_URL_SECONDS);
        return { status: 200, body: { url, expires_in: SIGNED_URL_SECONDS } };
    } catch (error) {
        return fromRpcError(error);
    }
};

export const handleDeleteDocument: Handler = async (ctx, body) => {
    const request = documentRequest.safeParse(body);
    if (!request.success) return badRequest;
    try {
        const path = await ctx.userRpc<string>('delete_document', { p_document_id: request.data.document_id });
        const cleared = await purgeStorage(ctx, [path]);
        return { status: 200, body: { deleted: true, storage_cleared: cleared } };
    } catch (error) {
        return fromRpcError(error);
    }
};

export const handleDeleteCareFile: Handler = async (ctx, body) => {
    const request = careFileRequest.safeParse(body);
    if (!request.success) return badRequest;
    const fileId = request.data.care_file_id;
    try {
        const counts = await ctx.userRpc<Record<string, number>>('delete_care_file', { p_care_file_id: fileId });
        // Le dossier est supprimé : un échec ici laisse les chemins dans la file, sans faire échouer la réponse.
        const cleared = await ctx
            .queuedPaths(`${fileId}/`)
            .then((paths) => purgeStorage(ctx, paths))
            .catch(() => false);
        return { status: 200, body: { counts, storage_cleared: cleared } };
    } catch (error) {
        return fromRpcError(error);
    }
};

// ----------------------------------------------------------------------------- navigateur de droits
const explainRequest = z.object({ program_id: z.uuid() });
const letterRequest = z.object({ program_id: z.uuid(), kind: z.enum(LETTER_KINDS) });

const programForAiSchema = z.object({
    id: z.uuid(),
    version: z.number(),
    name: z.string(),
    organization: z.string(),
    summary: z.string(),
    criteria: criteriaSchema,
    required_documents: z.array(z.string()),
    how_to_apply: z.string().nullable(),
    source_label: z.string(),
    cached_explanation: z.unknown().nullable(),
    cached_letter: z.string().nullable()
});
type ProgramForAi = z.infer<typeof programForAiSchema>;

/** « Je ne sais pas » : aucune sortie fiable ; l'application montre la fiche telle quelle. */
const unavailable: HandlerResponse = { status: 200, body: { status: 'unavailable' } };

async function loadProgram(ctx: ServerContext, programId: string, letterKind: string | null): Promise<ProgramForAi | null> {
    const raw = await ctx.userRpc<unknown>('program_for_ai', { p_program_id: programId, p_letter_kind: letterKind });
    if (raw === null || raw === undefined) return null;
    return programForAiSchema.parse(raw);
}

async function callModel<T, R>(
    ctx: ServerContext,
    purpose: 'program_explanation' | 'letter_draft',
    call: (fiche: ProgramFiche) => Promise<LlmResult<T>>,
    guard: (output: T, fiche: ProgramFiche) => R | null,
    fiche: ProgramFiche
): Promise<{ value: R; model: string } | null> {
    if (!ctx.llm) return null;
    const started = Date.now();
    const result = await call(fiche);
    const value = result.status === 'ok' && result.output !== null ? guard(result.output, fiche) : null;
    await ctx
        .recordAiCall({
            user_id: ctx.userId,
            care_file_id: null,
            purpose,
            provider: ctx.llm.provider,
            model: result.model,
            status: result.status === 'ok' ? (value === null ? 'guard_flagged' : 'ok') : result.status,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
            latency_ms: Math.max(0, Date.now() - started),
            pseudonymized_counts: {}
        })
        .catch(() => serverLog('function_error', { code: 'ai_call_log' }));
    return value === null ? null : { value, model: result.model };
}

export const handleExplainProgram: Handler = async (ctx, body) => {
    const request = explainRequest.safeParse(body);
    if (!request.success) return badRequest;
    try {
        const program = await loadProgram(ctx, request.data.program_id, null);
        if (!program) return { status: 404, body: { error: 'not_found' } };
        const cached = explanationOutputSchema.safeParse(program.cached_explanation);
        if (program.cached_explanation && cached.success) {
            return { status: 200, body: { status: 'ok', explanation: cached.data, cached: true } };
        }
        const fiche = ficheFromProgram(program);
        const produced = await callModel(
            ctx,
            'program_explanation',
            (f) => ctx.llm!.explainProgram(f),
            (output, f) => {
                const guarded = guardExplanation(output, f);
                return guarded.ok ? guarded.explanation : null;
            },
            fiche
        );
        if (!produced) return unavailable;
        await ctx.serviceRpc<void>('save_program_explanation', {
            p_program_id: program.id,
            p_version: program.version,
            p_explanation: produced.value,
            p_model: produced.model
        });
        return { status: 200, body: { status: 'ok', explanation: produced.value, cached: false } };
    } catch (error) {
        return fromRpcError(error);
    }
};

export const handleDraftLetter: Handler = async (ctx, body) => {
    const request = letterRequest.safeParse(body);
    if (!request.success) return badRequest;
    const { program_id: programId, kind } = request.data;
    try {
        const program = await loadProgram(ctx, programId, kind);
        if (!program) return { status: 404, body: { error: 'not_found' } };
        if (program.cached_letter) return { status: 200, body: { status: 'ok', template: program.cached_letter, cached: true } };
        const produced = await callModel(
            ctx,
            'letter_draft',
            (f) => ctx.llm!.draftLetter(f, kind),
            (output, f) => {
                const guarded = guardLetter(output, f);
                return guarded.ok ? guarded.letter : null;
            },
            ficheFromProgram(program)
        );
        if (!produced) return unavailable;
        await ctx.serviceRpc<void>('save_program_letter_template', {
            p_program_id: program.id,
            p_version: program.version,
            p_kind: kind,
            p_template: produced.value,
            p_model: produced.model
        });
        return { status: 200, body: { status: 'ok', template: produced.value, cached: false } };
    } catch (error) {
        return fromRpcError(error);
    }
};

export const HANDLERS: Record<string, Handler> = {
    'extract-document': handleExtractDocument,
    'get-document-url': handleDocumentUrl,
    'delete-document': handleDeleteDocument,
    'delete-care-file': handleDeleteCareFile,
    'explain-program': handleExplainProgram,
    'draft-letter': handleDraftLetter
};
