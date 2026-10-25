import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    extractDocument,
    MAX_PAGES_READ,
    type AiCallRow,
    type ExtractionDeps,
    type ExtractionStart,
    type SaveExtraction
} from '../../supabase/functions/_shared/extract';
import { RpcError } from '../../supabase/functions/_shared/handlers';
import { setServerLogSink } from '../../supabase/functions/_shared/log';
import type { OcrClient } from '../../supabase/functions/_shared/ocr';
import { DISCHARGE_SUMMARY_PAGES, FICTIONAL_DICTIONARY, FICTIONAL_IDENTIFIERS, PRESCRIPTION_PAGES } from '../support/documents';
import { buildTextPdf } from '../support/pdf';
import { SimulatedLlm } from '../support/simulated-llm';

const DOC = 'd1000000-0000-4000-8000-000000000001';
const FILE = 'f1000000-0000-4000-8000-000000000001';
const ACTOR = 'a0000000-0000-4000-8000-00000000000a';

interface Harness {
    deps: ExtractionDeps;
    llm: SimulatedLlm;
    saved: SaveExtraction[];
    failed: Array<{ code: string; pageCount: number | null }>;
    aiCalls: AiCallRow[];
    logs: Array<Record<string, string | number>>;
}

let logs: Array<Record<string, string | number>> = [];
beforeEach(() => {
    logs = [];
    setServerLogSink((entry) => logs.push(entry));
});
afterEach(() => setServerLogSink(null));

function harness(file: Uint8Array, mimeType = 'application/pdf', overrides: Partial<ExtractionDeps> = {}): Harness {
    const llm = new SimulatedLlm();
    const saved: SaveExtraction[] = [];
    const failed: Harness['failed'] = [];
    const aiCalls: AiCallRow[] = [];
    const start: ExtractionStart = {
        care_file_id: FILE,
        storage_path: `${FILE}/${DOC}`,
        mime_type: mimeType,
        ...FICTIONAL_DICTIONARY
    };
    const deps: ExtractionDeps = {
        llm,
        ocr: null,
        start: async () => start,
        download: async (path) => {
            expect(path).toBe(`${FILE}/${DOC}`);
            return file;
        },
        save: async (input) => {
            saved.push(input);
            return 'e1000000-0000-4000-8000-000000000001';
        },
        fail: async (_id, code, pageCount) => {
            failed.push({ code, pageCount });
        },
        recordAiCall: async (row) => {
            aiCalls.push(row);
        },
        ...overrides
    };
    return { deps, llm, saved, failed, aiCalls, logs };
}

const dischargePdf = buildTextPdf(DISCHARGE_SUMMARY_PAGES);

describe('extraction d’un document (IA simulée)', () => {
    it('produit un brouillon d’un PDF de 3 pages, sans envoyer aucun identifiant', async () => {
        const h = harness(dischargePdf);
        const started = performance.now();
        const result = await extractDocument(h.deps, DOC, ACTOR);
        const elapsed = performance.now() - started;

        expect(result.status).toBe('draft_ready');
        expect(h.llm.inputs).toHaveLength(1);
        const sent = h.llm.inputs[0] as string;
        for (const identifier of FICTIONAL_IDENTIFIERS) expect(sent).not.toContain(identifier);
        expect(sent).toContain('Metformine 500 mg 2 fois par jour');
        expect(sent).toContain('--- Page 3 ---');

        expect(h.saved).toHaveLength(1);
        const { draft, pageCount } = h.saved[0]!;
        expect(pageCount).toBe(3);
        expect(draft.document_type).toBe('discharge_summary');
        expect(draft.document_date).toBe('2026-10-03');
        expect(draft.author).toBe('Dre Isabelle Fortin, gériatre'); // ré-identifié localement
        expect(draft.medications.map((m) => [m.name, m.dosage, m.frequency, m.unverified])).toEqual([
            ['Metformine', '500 mg', '2 fois par jour', false],
            ['Ramipril', '5 mg', '1 fois par jour', false],
            ['Atorvastatine', '20 mg', 'au coucher', false]
        ]);
        expect(draft.appointments[0]).toMatchObject({ date: '2026-11-12', purpose: 'Rendez-vous en gériatrie', unverified: false });
        expect(draft.action_items[0]?.text).toBe('prise de sang au CLSC dans deux semaines');
        expect(draft.timeline_events.map((e) => [e.event_type, e.date])).toEqual([
            ['hospitalization', '2026-09-26'],
            ['discharge', '2026-10-03']
        ]);
        expect(draft.needs_review).toBe(false);
        // Hors appel au modèle, le traitement local est rapide (la cible totale est de 30 s).
        expect(elapsed).toBeLessThan(5000);
    });

    it('journalise l’appel à l’IA sans aucun contenu', async () => {
        const h = harness(dischargePdf);
        await extractDocument(h.deps, DOC, ACTOR);
        expect(h.aiCalls).toHaveLength(1);
        const call = h.aiCalls[0]!;
        expect(call).toMatchObject({
            user_id: ACTOR,
            care_file_id: FILE,
            purpose: 'document_extraction',
            status: 'ok',
            model: 'simulated'
        });
        expect(call.pseudonymized_counts).toMatchObject({ health_card: 1, sin: 1, birth_date: 1, record_number: 1 });
        const serialized = JSON.stringify([call, h.logs]);
        for (const identifier of [...FICTIONAL_IDENTIFIERS, 'Metformine', 'gériatre']) expect(serialized).not.toContain(identifier);
        expect(h.logs.map((l) => l.event)).toEqual(['extraction_completed']);
    });

    it('retire le conseil ajouté par l’IA et marque le médicament inventé', async () => {
        const h = harness(buildTextPdf([...PRESCRIPTION_PAGES.map((p) => [...p, 'TEST-CONSEIL'])]));
        const result = await extractDocument(h.deps, DOC, ACTOR);
        expect(result.status).toBe('draft_ready');
        const draft = h.saved[0]!.draft;
        expect(draft.plain_summary).toBeNull();
        expect(draft.guard_flags).toEqual(expect.arrayContaining(['advice_language', 'not_in_source']));
        expect(draft.medications.find((m) => m.name === 'Aspirine')?.unverified).toBe(true);
        expect(draft.medications.find((m) => m.name === 'Metformine')).toMatchObject({ frequency: 'BID', unverified: false });
        expect(draft.needs_review).toBe(true);
        expect(h.aiCalls[0]?.status).toBe('guard_flagged');
    });

    it('PDF numérisé sans texte : pas d’appel à l’IA, saisie à la main', async () => {
        const h = harness(buildTextPdf([[], []]));
        const result = await extractDocument(h.deps, DOC, ACTOR);
        expect(result).toEqual({ status: 'failed', code: 'no_text_layer' });
        expect(h.failed).toEqual([{ code: 'no_text_layer', pageCount: null }]);
        expect(h.llm.inputs).toHaveLength(0);
    });

    it('photo sans OCR configuré : pas d’appel à l’IA', async () => {
        const h = harness(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg');
        expect(await extractDocument(h.deps, DOC, ACTOR)).toEqual({ status: 'failed', code: 'photo_without_ocr' });
        expect(h.llm.inputs).toHaveLength(0);
    });

    it('photo avec OCR : le texte est pseudonymisé ; une faible confiance marque « à vérifier »', async () => {
        const ocr: OcrClient = {
            provider: 'test',
            recognize: async () => ({ text: PRESCRIPTION_PAGES[0]!.join('\n'), confidence: 0.6 })
        };
        const h = harness(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg', { ocr });
        expect((await extractDocument(h.deps, DOC, ACTOR)).status).toBe('draft_ready');
        expect(h.llm.inputs[0]).not.toContain('Gagnon');
        expect(h.saved[0]!.draft).toMatchObject({ needs_review: true, review_reasons: expect.arrayContaining(['blurry']) });
    });

    it('refus, sortie invalide ou panne du modèle : échec noté, appel journalisé', async () => {
        for (const [mode, code] of [
            ['refusal', 'refusal'],
            ['schema_error', 'invalid_output'],
            ['error', 'ai_unavailable']
        ] as const) {
            const h = harness(dischargePdf);
            h.llm.mode = mode;
            expect(await extractDocument(h.deps, DOC, ACTOR)).toEqual({ status: 'failed', code });
            expect(h.failed[0]).toEqual({ code, pageCount: 3 });
            expect(h.aiCalls[0]?.status).toBe(mode);
            expect(h.saved).toHaveLength(0);
        }
    });

    it('sans fournisseur d’IA configuré : échec « ai_unavailable »', async () => {
        const h = harness(dischargePdf, 'application/pdf', { llm: null });
        expect(await extractDocument(h.deps, DOC, ACTOR)).toEqual({ status: 'failed', code: 'ai_unavailable' });
    });

    it('PDF illisible ou trop long', async () => {
        const broken = harness(new TextEncoder().encode('pas un pdf'));
        expect(await extractDocument(broken.deps, DOC, ACTOR)).toEqual({ status: 'failed', code: 'unreadable_pdf' });
        const pages = Array.from({ length: MAX_PAGES_READ + 1 }, () => ['Page de texte suffisamment longue pour compter.']);
        const long = harness(buildTextPdf(pages));
        expect(await extractDocument(long.deps, DOC, ACTOR)).toEqual({ status: 'failed', code: 'too_long' });
        expect(long.llm.inputs).toHaveLength(0);
    });

    it('les refus de la base (droits, consentement) remontent tels quels, sans rien lire', async () => {
        const h = harness(dischargePdf, 'application/pdf', {
            start: async () => {
                throw new RpcError('RLA01');
            }
        });
        await expect(extractDocument(h.deps, DOC, ACTOR)).rejects.toMatchObject({ code: 'RLA01' });
        expect(h.failed).toHaveLength(0);
        expect(h.llm.inputs).toHaveLength(0);
    });
});
