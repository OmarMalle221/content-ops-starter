import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    handleDeleteCareFile,
    handleDeleteDocument,
    handleDocumentUrl,
    handleExtractDocument,
    RpcError,
    type ServerContext
} from '../../supabase/functions/_shared/handlers';
import { setServerLogSink } from '../../supabase/functions/_shared/log';
import { DISCHARGE_SUMMARY_PAGES, FICTIONAL_DICTIONARY } from '../support/documents';
import { buildTextPdf } from '../support/pdf';
import { SimulatedLlm } from '../support/simulated-llm';

const DOC = 'd1000000-0000-4000-8000-000000000001';
const FILE = 'f1000000-0000-4000-8000-000000000001';

let logs: Array<Record<string, string | number>> = [];
beforeEach(() => {
    logs = [];
    setServerLogSink((entry) => logs.push(entry));
});
afterEach(() => setServerLogSink(null));

function context(overrides: Partial<ServerContext> = {}) {
    const removed: string[][] = [];
    const cleared: string[][] = [];
    const ctx: ServerContext = {
        userId: 'a0000000-0000-4000-8000-00000000000a',
        userRpc: vi.fn(async (fn: string) => {
            if (fn === 'start_document_extraction') {
                return { care_file_id: FILE, storage_path: `${FILE}/${DOC}`, mime_type: 'application/pdf', ...FICTIONAL_DICTIONARY };
            }
            if (fn === 'authorize_document_download' || fn === 'delete_document') return `${FILE}/${DOC}`;
            if (fn === 'delete_care_file') return { documents: 2 };
            throw new Error(`unexpected ${fn}`);
        }) as ServerContext['userRpc'],
        serviceRpc: vi.fn(async (fn: string) =>
            fn === 'save_document_extraction' ? 'e1000000-0000-4000-8000-000000000001' : null
        ) as ServerContext['serviceRpc'],
        storage: {
            download: async () => buildTextPdf(DISCHARGE_SUMMARY_PAGES),
            remove: vi.fn(async (paths: string[]) => {
                removed.push(paths);
            }),
            signedUrl: vi.fn(async (path: string, seconds: number) => `https://storage.example/${path}?expires=${seconds}`)
        },
        queuedPaths: vi.fn(async (prefix: string) => [`${prefix}${DOC}`, `${prefix}d2000000-0000-4000-8000-000000000002`]),
        clearQueuedPaths: vi.fn(async (paths: string[]) => {
            cleared.push(paths);
        }),
        recordAiCall: vi.fn(async () => undefined),
        llm: new SimulatedLlm(),
        ocr: null,
        ...overrides
    };
    return { ctx, removed, cleared };
}

describe('fonctions serveur', () => {
    it('refusent une requête mal formée', async () => {
        const { ctx } = context();
        for (const handler of [handleExtractDocument, handleDocumentUrl, handleDeleteDocument]) {
            expect(await handler(ctx, { document_id: 'pas-un-uuid' })).toEqual({ status: 400, body: { error: 'bad_request' } });
            expect(await handler(ctx, null)).toEqual({ status: 400, body: { error: 'bad_request' } });
        }
        expect((await handleDeleteCareFile(ctx, {})).status).toBe(400);
    });

    it('extract-document : brouillon enregistré avec la clé serveur', async () => {
        const { ctx } = context();
        const response = await handleExtractDocument(ctx, { document_id: DOC });
        expect(response).toEqual({ status: 200, body: { status: 'draft_ready', extraction_id: 'e1000000-0000-4000-8000-000000000001' } });
        expect(ctx.userRpc).toHaveBeenCalledWith('start_document_extraction', { p_document_id: DOC });
        expect(ctx.serviceRpc).toHaveBeenCalledWith(
            'save_document_extraction',
            expect.objectContaining({ p_document_id: DOC, p_schema_version: '1', p_page_count: 3, p_legibility: 'clear' })
        );
    });

    it('extract-document : consentement absent, état du document, accès refusé', async () => {
        for (const [code, status, error] of [
            ['RLA01', 403, 'ai_consent_missing'],
            ['RLA02', 409, 'document_state'],
            ['42501', 403, 'forbidden']
        ] as const) {
            const { ctx } = context({
                userRpc: async () => {
                    throw new RpcError(code);
                }
            });
            expect(await handleExtractDocument(ctx, { document_id: DOC })).toEqual({ status, body: { error } });
        }
    });

    it('get-document-url : accès vérifié par la base, URL de 60 secondes', async () => {
        const { ctx } = context();
        const response = await handleDocumentUrl(ctx, { document_id: DOC });
        expect(ctx.userRpc).toHaveBeenCalledWith('authorize_document_download', { p_document_id: DOC });
        expect(ctx.storage.signedUrl).toHaveBeenCalledWith(`${FILE}/${DOC}`, 60);
        expect(response).toEqual({ status: 200, body: { url: `https://storage.example/${FILE}/${DOC}?expires=60`, expires_in: 60 } });
    });

    it('delete-document : le fichier est effacé de Storage et retiré de la file', async () => {
        const { ctx, removed, cleared } = context();
        expect(await handleDeleteDocument(ctx, { document_id: DOC })).toEqual({
            status: 200,
            body: { deleted: true, storage_cleared: true }
        });
        expect(removed).toEqual([[`${FILE}/${DOC}`]]);
        expect(cleared).toEqual([[`${FILE}/${DOC}`]]);
    });

    it('delete-document : si Storage échoue, la file garde le chemin pour une reprise', async () => {
        const { ctx, cleared } = context();
        ctx.storage.remove = async () => {
            throw new Error('réseau indisponible');
        };
        expect(await handleDeleteDocument(ctx, { document_id: DOC })).toEqual({
            status: 200,
            body: { deleted: true, storage_cleared: false }
        });
        expect(cleared).toEqual([]);
        expect(logs).toEqual([expect.objectContaining({ event: 'storage_purge_failed', count: 1 })]);
        expect(JSON.stringify(logs)).not.toContain('réseau');
    });

    it('delete-care-file : tous les fichiers du dossier sont effacés', async () => {
        const { ctx, removed } = context();
        const response = await handleDeleteCareFile(ctx, { care_file_id: FILE });
        expect(response).toEqual({ status: 200, body: { counts: { documents: 2 }, storage_cleared: true } });
        expect(ctx.queuedPaths).toHaveBeenCalledWith(`${FILE}/`);
        expect(removed[0]).toHaveLength(2);
    });

    it('une erreur inattendue ne renvoie aucun détail et n’en journalise aucun', async () => {
        const { ctx } = context({
            userRpc: async () => {
                throw new Error('Roger Gagnon introuvable');
            }
        });
        expect(await handleDocumentUrl(ctx, { document_id: DOC })).toEqual({ status: 500, body: { error: 'internal' } });
        expect(JSON.stringify(logs)).not.toContain('Roger');
    });
});
