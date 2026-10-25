// Test RÉEL avec l'API Claude : un PDF fictif de 3 pages doit donner un brouillon en moins de 30 s.
// Ignoré sans ANTHROPIC_API_KEY. Lancement : ANTHROPIC_API_KEY=… npm run test:ai-live
// (modèle : ANTHROPIC_MODEL, sinon claude-sonnet-5-5). Le texte envoyé est pseudonymisé.
import { describe, expect, it } from 'vitest';
import { extractDocument, type ExtractionStart, type SaveExtraction } from '../../supabase/functions/_shared/extract';
import { AnthropicLlmClient, type LlmClient } from '../../supabase/functions/_shared/llm';
import { DISCHARGE_SUMMARY_PAGES, FICTIONAL_DICTIONARY, FICTIONAL_IDENTIFIERS } from '../support/documents';
import { buildTextPdf } from '../support/pdf';

const apiKey = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!apiKey)('extraction réelle (API Claude)', () => {
    it('PDF fictif de 3 pages → brouillon en moins de 30 s, sans identifiant envoyé', { timeout: 60_000 }, async () => {
        const real = new AnthropicLlmClient({ apiKey: apiKey as string, model: process.env.ANTHROPIC_MODEL });
        const sent: string[] = [];
        const llm: LlmClient = {
            provider: real.provider,
            model: real.model,
            extractDocument: (input) => {
                sent.push(input.text);
                return real.extractDocument(input);
            }
        };
        const saved: SaveExtraction[] = [];
        const start: ExtractionStart = { care_file_id: 'f', storage_path: 'f/d', mime_type: 'application/pdf', ...FICTIONAL_DICTIONARY };

        const started = performance.now();
        const result = await extractDocument(
            {
                llm,
                ocr: null,
                start: async () => start,
                download: async () => buildTextPdf(DISCHARGE_SUMMARY_PAGES),
                save: async (input) => {
                    saved.push(input);
                    return 'e';
                },
                fail: async () => undefined,
                recordAiCall: async () => undefined
            },
            'd',
            'a'
        );
        const elapsed = performance.now() - started;
        console.info(`[extraction réelle] ${Math.round(elapsed)} ms, statut ${result.status}`);

        expect(result.status).toBe('draft_ready');
        expect(elapsed).toBeLessThan(30_000);
        for (const identifier of FICTIONAL_IDENTIFIERS) expect(sent[0]).not.toContain(identifier);
        const draft = saved[0]!.draft;
        expect(draft.document_type).toBe('discharge_summary');
        expect(draft.medications.map((m) => m.name)).toEqual(expect.arrayContaining(['Metformine', 'Ramipril', 'Atorvastatine']));
        // Aucune formulation de conseil n'a survécu aux garde-fous.
        expect(draft.plain_summary ?? '').not.toMatch(/vous devriez|il faut|augmenter|diminuer/i);
    });
});
