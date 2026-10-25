// IA SIMULÉE, déterministe, pour les tests et la démonstration locale (aucun appel réseau).
// Elle lit le texte pseudonymisé comme le ferait le modèle et produit une sortie du schéma v1.
// Marqueur « TEST-CONSEIL » dans le document : elle ajoute volontairement un conseil et un médicament
// inventé, pour montrer les garde-fous.
import type { LlmClient, LlmExtractionResult } from '../../supabase/functions/_shared/llm.ts';
import type { ModelOutput } from '../../src/shared/extraction/schema.ts';

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DATE = new RegExp(`(\\d{1,2})(?:er)?\\s+(${MONTHS.join('|')})\\s+(\\d{4})`, 'i');

function isoDate(line: string): string | null {
    const m = DATE.exec(line);
    if (!m) return null;
    const month = MONTHS.indexOf((m[2] as string).toLowerCase()) + 1;
    return `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

export function simulateExtraction(text: string): ModelOutput {
    const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const find = (pattern: RegExp) => lines.find((l) => pattern.test(l));

    const type: ModelOutput['document_type'] = /r[ée]sum[ée] de d[ée]part/i.test(text)
        ? 'discharge_summary'
        : /ordonnance/i.test(text)
          ? 'prescription'
          : /rendez-vous/i.test(text)
            ? 'appointment_notice'
            : 'other';

    const departure = find(/date de d[ée]part/i);
    const dated = find(/^date\s*:/i) ?? lines.find((l) => isoDate(l) !== null);
    const documentDate = isoDate(departure ?? dated ?? '');
    const authorLine = find(/^(?:m[ée]decin traitant|signature)\s*:/i);
    const author = authorLine ? authorLine.replace(/^[^:]+:\s*/, '') : (find(/^Dre?\s+\[PERSONNE_\d+\]/) ?? null);

    const medications = lines
        .map((line) => ({ line, m: /^-\s*([\p{L}][\p{L}-]+)\s+(\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|UI))\s*(.*)$/u.exec(line) }))
        .filter((x) => x.m)
        .map(({ line, m }) => ({
            name: m![1] as string,
            dosage: m![2] as string,
            frequency: (m![3] as string).trim() || null,
            source_line: line
        }));

    const appointments = lines
        .filter((line) => /rendez-vous/i.test(line) && isoDate(line))
        .map((line) => ({
            date: isoDate(line),
            time: /(\d{1,2}\s*h\s*\d{0,2})/.exec(line)?.[1]?.trim() ?? null,
            place: line.split(',').slice(1).join(',').replace(/\.$/, '').trim() || null,
            purpose: line.split(/\s+le\s+\d/)[0] ?? line,
            source_line: line
        }));

    const actionItems = lines
        .filter((line) => /^à faire\s*:/i.test(line))
        .map((line) => ({ text: line.replace(/^[^:]+:\s*/, '').replace(/\.$/, ''), source_line: line }));

    const timeline: ModelOutput['timeline_events'] = [];
    const admission = find(/date d['’]admission/i);
    const reason = find(/motif de l['’]hospitalisation/i);
    if (admission && reason) {
        timeline.push({
            date: isoDate(admission),
            event_type: 'hospitalization',
            title: `Hospitalisation : ${reason.replace(/^[^:]+:\s*/, '').replace(/\.$/, '')}`,
            source_line: reason
        });
    }
    const back = find(/^retour /i);
    if (back)
        timeline.push({ date: isoDate(back), event_type: 'discharge', title: back.split(/\s+le\s+\d/)[0] ?? back, source_line: back });

    let summary =
        type === 'discharge_summary'
            ? 'Ce document résume un séjour à l’hôpital et le retour à la résidence. Il liste des médicaments et un rendez-vous de suivi.'
            : type === 'prescription'
              ? 'Ce document est une ordonnance qui liste des médicaments.'
              : 'Ce document mentionne des renseignements à relire.';
    if (text.includes('TEST-CONSEIL')) {
        summary += ' Vous devriez augmenter la dose de metformine.';
        medications.push({ name: 'Aspirine', dosage: '81 mg', frequency: '1 fois par jour', source_line: 'Aspirine 81 mg' });
    }

    return {
        document_type: type,
        document_date: documentDate,
        author,
        title: type === 'discharge_summary' ? 'Résumé de départ de l’hôpital' : type === 'prescription' ? 'Ordonnance' : 'Document',
        plain_summary: summary,
        medications_as_written: medications,
        appointments,
        action_items: actionItems,
        timeline_events: timeline,
        legibility: 'clear',
        needs_review: false,
        review_reasons: []
    };
}

export class SimulatedLlm implements LlmClient {
    readonly provider = 'anthropic' as const;
    readonly model = 'simulated';
    /** Textes reçus : les tests vérifient qu'aucun identifiant n'y figure. */
    readonly inputs: string[] = [];
    mode: 'ok' | 'refusal' | 'schema_error' | 'error' = 'ok';

    async extractDocument(input: { text: string; pageCount: number }): Promise<LlmExtractionResult> {
        this.inputs.push(input.text);
        const usage = { model: this.model, inputTokens: Math.ceil(input.text.length / 4), outputTokens: 400 };
        if (this.mode === 'error')
            return { status: 'error', output: null, model: this.model, inputTokens: null, outputTokens: null, errorCode: 'timeout' };
        if (this.mode !== 'ok') return { status: this.mode, output: null, ...usage };
        return { status: 'ok', output: simulateExtraction(input.text), ...usage };
    }
}
