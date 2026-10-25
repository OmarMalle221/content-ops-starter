import { describe, expect, it, vi } from 'vitest';
import programsJson from '../../src/content/programs.fr.json';
import type { AiCallRow } from '../../supabase/functions/_shared/extract';
import { handleDraftLetter, handleExplainProgram, type ServerContext } from '../../supabase/functions/_shared/handlers';
import { SimulatedLlm } from '../support/simulated-llm';

const PROGRAM_ID = 'b1000000-0000-4000-8000-000000000001';
const raw = programsJson.find((p) => p.slug === 'credit-impot-personnes-handicapees')!;

function context(program: Record<string, unknown> | null) {
    const aiCalls: AiCallRow[] = [];
    const llm = new SimulatedLlm();
    const ctx: ServerContext = {
        userId: 'a0000000-0000-4000-8000-00000000000a',
        userRpc: vi.fn(async () => program) as ServerContext['userRpc'],
        serviceRpc: vi.fn(async () => null) as ServerContext['serviceRpc'],
        storage: { download: vi.fn(), remove: vi.fn(), signedUrl: vi.fn() },
        queuedPaths: vi.fn(async () => []),
        clearQueuedPaths: vi.fn(async () => undefined),
        recordAiCall: vi.fn(async (row: AiCallRow) => {
            aiCalls.push(row);
        }),
        llm,
        ocr: null
    };
    return { ctx, llm, aiCalls };
}

const fiche = (overrides: Record<string, unknown> = {}) => ({
    id: PROGRAM_ID,
    version: 3,
    name: raw.name,
    organization: raw.organization,
    summary: raw.summary,
    criteria: raw.criteria,
    required_documents: raw.required_documents,
    how_to_apply: raw.how_to_apply,
    source_label: raw.source_label,
    cached_explanation: null,
    cached_letter: null,
    ...overrides
});

describe('explain-program', () => {
    it('explique à partir de la seule fiche, met en cache pour sa version, journalise sans contenu', async () => {
        const { ctx, llm, aiCalls } = context(fiche());
        const response = await handleExplainProgram(ctx, { program_id: PROGRAM_ID });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'ok', cached: false, explanation: { plain_explanation: expect.any(String) } });
        expect(ctx.userRpc).toHaveBeenCalledWith('program_for_ai', { p_program_id: PROGRAM_ID, p_letter_kind: null });
        expect(ctx.serviceRpc).toHaveBeenCalledWith(
            'save_program_explanation',
            expect.objectContaining({ p_program_id: PROGRAM_ID, p_version: 3 })
        );
        // Ce qui part vers le modèle : la fiche, rien du dossier.
        expect(JSON.parse(llm.inputs[0]!)).toEqual(
            expect.objectContaining({ name: raw.name, organization: raw.organization, required_documents: raw.required_documents })
        );
        expect(aiCalls).toEqual([
            expect.objectContaining({ purpose: 'program_explanation', status: 'ok', care_file_id: null, pseudonymized_counts: {} })
        ]);
    });

    it('sert le cache sans rappeler le modèle', async () => {
        const cached = { plain_explanation: 'Déjà expliqué.', who_it_may_help: [], steps: [], not_in_fiche: [] };
        const { ctx, llm } = context(fiche({ cached_explanation: cached }));
        expect(await handleExplainProgram(ctx, { program_id: PROGRAM_ID })).toEqual({
            status: 200,
            body: { status: 'ok', explanation: cached, cached: true }
        });
        expect(llm.inputs).toHaveLength(0);
    });

    it('garde-fou : un montant inventé donne « je ne sais pas », rien n’est mis en cache', async () => {
        const { ctx, aiCalls } = context(fiche({ summary: `${raw.summary} TEST-INVENTION` }));
        expect(await handleExplainProgram(ctx, { program_id: PROGRAM_ID })).toEqual({ status: 200, body: { status: 'unavailable' } });
        expect(ctx.serviceRpc).not.toHaveBeenCalled();
        expect(aiCalls[0]?.status).toBe('guard_flagged');
    });

    it('modèle indisponible ou refus : « je ne sais pas »', async () => {
        const { ctx, llm, aiCalls } = context(fiche());
        llm.mode = 'refusal';
        expect(await handleExplainProgram(ctx, { program_id: PROGRAM_ID })).toEqual({ status: 200, body: { status: 'unavailable' } });
        expect(aiCalls[0]?.status).toBe('refusal');
        const none = context(fiche());
        none.ctx.llm = null;
        expect(await handleExplainProgram(none.ctx, { program_id: PROGRAM_ID })).toEqual({ status: 200, body: { status: 'unavailable' } });
    });

    it('fiche inactive ou inconnue : 404 ; requête mal formée : 400', async () => {
        expect((await handleExplainProgram(context(null).ctx, { program_id: PROGRAM_ID })).status).toBe(404);
        expect((await handleExplainProgram(context(fiche()).ctx, { program_id: 'x' })).status).toBe(400);
    });
});

describe('draft-letter', () => {
    it('modèle à espaces réservés, mis en cache par version et par type de lettre', async () => {
        const { ctx } = context(fiche());
        const response = await handleDraftLetter(ctx, { program_id: PROGRAM_ID, kind: 'information_request' });
        expect(response.body).toMatchObject({ status: 'ok', cached: false });
        expect(String(response.body.template)).toContain('[NOM DE LA PERSONNE AIDÉE]');
        expect(ctx.userRpc).toHaveBeenCalledWith('program_for_ai', { p_program_id: PROGRAM_ID, p_letter_kind: 'information_request' });
        expect(ctx.serviceRpc).toHaveBeenCalledWith(
            'save_program_letter_template',
            expect.objectContaining({ p_kind: 'information_request', p_version: 3 })
        );
    });

    it('sert le cache ; refuse un type de lettre inconnu', async () => {
        const { ctx, llm } = context(fiche({ cached_letter: 'Lettre en cache [VOTRE NOM]' }));
        expect((await handleDraftLetter(ctx, { program_id: PROGRAM_ID, kind: 'application_follow_up' })).body).toEqual({
            status: 'ok',
            template: 'Lettre en cache [VOTRE NOM]',
            cached: true
        });
        expect(llm.inputs).toHaveLength(0);
        expect((await handleDraftLetter(ctx, { program_id: PROGRAM_ID, kind: 'mise_en_demeure' })).status).toBe(400);
    });
});
