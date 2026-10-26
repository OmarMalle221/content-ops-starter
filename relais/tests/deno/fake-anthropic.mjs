// Fausse API Messages d'Anthropic (POST /v1/messages), pour essayer le VRAI client (SDK officiel, sous
// Deno) sans clé ni réseau. Chaque requête reçue est gardée telle quelle : les tests vérifient ce qui
// sort réellement du serveur (aucun nom, aucun numéro : règle 6), le modèle, le repli et le format demandé.
//
// Réponses produites par l'IA simulée des tests (sortie structurée : JSON dans un bloc texte, comme
// l'API). Marqueurs dans le document : « TEST-REFUS » → refus du modèle ; « TEST-PANNE » → erreur 529.
import http from 'node:http';
import {
    EXPLANATION_SYSTEM_PROMPT,
    EXTRACTION_SYSTEM_PROMPT,
    LETTER_KIND_PURPOSE,
    LETTER_SYSTEM_PROMPT
} from '../../supabase/functions/_shared/llm.ts';
import { simulateExplanation, simulateExtraction, simulateLetter } from '../support/simulated-llm.ts';

/** Fiche reconstruite depuis le texte envoyé (format de ficheText, src/shared/benefits/ai.ts). */
function ficheFromText(text) {
    const field = (label) => new RegExp(`^${label} : (.*)$`, 'm').exec(text)?.[1] ?? '';
    const list = (label, none) => (field(label) === none ? [] : field(label).split(' ; '));
    return {
        name: field('Programme'),
        organization: field('Organisme'),
        summary: field('Description'),
        criteria_labels: list('Conditions indiquées', 'aucune'),
        required_documents: list('Pièces à fournir', 'aucune indiquée'),
        how_to_apply: field('Comment faire la demande') === 'non indiqué' ? null : field('Comment faire la demande'),
        source_label: field('Source')
    };
}

function respond(body) {
    const user = body.messages?.[0]?.content ?? '';
    if (body.system === EXTRACTION_SYSTEM_PROMPT) {
        const text = /<document>\n([\s\S]*)\n<\/document>/.exec(user)?.[1] ?? '';
        if (text.includes('TEST-PANNE')) return { status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } };
        if (text.includes('TEST-REFUS')) return { refusal: true };
        return { output: simulateExtraction(text) };
    }
    const fiche = ficheFromText(/<fiche>\n([\s\S]*)\n<\/fiche>/.exec(user)?.[1] ?? '');
    if (body.system === EXPLANATION_SYSTEM_PROMPT) return { output: simulateExplanation(fiche) };
    if (body.system === LETTER_SYSTEM_PROMPT) {
        const kind = Object.entries(LETTER_KIND_PURPOSE).find(([, purpose]) => user.includes(purpose))?.[0];
        return { output: simulateLetter(fiche, kind ?? 'information_request') };
    }
    return { status: 400, error: { type: 'invalid_request_error', message: 'unexpected request' } };
}

export function startFakeAnthropic(port) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const url = new URL(req.url ?? '/', 'http://localhost');
        requests.push({
            path: url.pathname,
            headers: {
                authorization: req.headers.authorization ?? null,
                'x-api-key': req.headers['x-api-key'] ?? null,
                'anthropic-version': req.headers['anthropic-version'] ?? null,
                'anthropic-beta': req.headers['anthropic-beta'] ?? null
            },
            body
        });
        const send = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json', 'request-id': `req_fake_${requests.length}` });
            res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
            return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
        }
        const result = respond(body);
        if (result.error) return send(result.status, { type: 'error', error: result.error });
        const text = result.refusal ? null : JSON.stringify(result.output);
        return send(200, {
            id: `msg_fake_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: text === null ? [] : [{ type: 'text', text }],
            stop_reason: result.refusal ? 'refusal' : 'end_turn',
            stop_sequence: null,
            stop_details: result.refusal ? { type: 'refusal', category: null, explanation: null } : null,
            usage: {
                input_tokens: Math.ceil(JSON.stringify(body).length / 4),
                output_tokens: Math.ceil((text ?? '').length / 4)
            }
        });
    });
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve({ requests, close: () => server.close() }));
    });
}
