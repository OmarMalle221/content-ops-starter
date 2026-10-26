// Fonction notify-support : avis une seule fois, aux intervenantes, sans contenu de la demande.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '../../supabase/functions/_shared/email';
import { handleNotifySupport, RpcError, type ServerContext } from '../../supabase/functions/_shared/handlers';
import { setServerLogSink } from '../../supabase/functions/_shared/log';

const REQUEST_ID = '5e000000-0000-4000-8000-000000000001';
const USER_ID = 'c0000000-0000-4000-8000-00000000000c';

function context(claimed: unknown, options: { email?: boolean; failFor?: string } = {}) {
    const sent: EmailMessage[] = [];
    const ctx: ServerContext = {
        userId: USER_ID,
        userRpc: vi.fn() as ServerContext['userRpc'],
        serviceRpc: vi.fn(async () => claimed) as ServerContext['serviceRpc'],
        storage: { download: vi.fn(), remove: vi.fn(), signedUrl: vi.fn() },
        queuedPaths: vi.fn(async () => []),
        clearQueuedPaths: vi.fn(async () => undefined),
        recordAiCall: vi.fn(),
        llm: null,
        ocr: null,
        email:
            options.email === false
                ? null
                : {
                      send: async (message) => {
                          if (message.to === options.failFor)
                              throw Object.assign(new Error(`refused ${message.to}`), { name: 'EmailError' });
                          sent.push(message);
                      }
                  },
        appUrl: 'https://relais.example'
    };
    return { ctx, sent };
}

afterEach(() => setServerLogSink(null));

describe('notify-support', () => {
    it('réserve l’avis pour le demandeur, écrit à chaque intervenante, sans contenu', async () => {
        const { ctx, sent } = context({ origin: 'distress_screen', emails: ['nadia@relais.example', 'sophie@relais.example'] });
        const response = await handleNotifySupport(ctx, { request_id: REQUEST_ID });
        expect(response).toEqual({ status: 200, body: { status: 'sent', count: 2 } });
        expect(ctx.serviceRpc).toHaveBeenCalledWith('claim_support_notification', { p_request_id: REQUEST_ID, p_requester: USER_ID });
        expect(sent.map((m) => m.to)).toEqual(['nadia@relais.example', 'sophie@relais.example']);
        expect(sent[0]!.subject).toBe('Relais : nouvelle demande (écran d’urgence)');
        expect(sent[0]!.text).toContain('https://relais.example/intervenante');
    });

    it('déjà avisé (ou pas sa demande) : rien n’est envoyé', async () => {
        const { ctx, sent } = context(null);
        expect(await handleNotifySupport(ctx, { request_id: REQUEST_ID })).toEqual({ status: 200, body: { status: 'already_notified' } });
        expect(sent).toHaveLength(0);
    });

    it('échec d’un envoi : les autres partent, le journal ne garde aucune adresse', async () => {
        const logs: Array<Record<string, string | number>> = [];
        setServerLogSink((entry) => logs.push(entry));
        const { ctx, sent } = context(
            { origin: 'button', emails: ['nadia@relais.example', 'sophie@relais.example'] },
            { failFor: 'nadia@relais.example' }
        );
        expect((await handleNotifySupport(ctx, { request_id: REQUEST_ID })).body).toEqual({ status: 'sent', count: 1 });
        expect(sent.map((m) => m.to)).toEqual(['sophie@relais.example']);
        expect(JSON.stringify(logs)).not.toMatch(/relais\.example|nadia|sophie/);
    });

    it('sans fournisseur de courriel : la demande reste dans le tableau', async () => {
        const { ctx } = context({ origin: 'button', emails: ['nadia@relais.example'] }, { email: false });
        expect((await handleNotifySupport(ctx, { request_id: REQUEST_ID })).body).toEqual({ status: 'email_not_configured' });
    });

    it('requête invalide ou refusée par la base', async () => {
        const { ctx } = context(null);
        expect((await handleNotifySupport(ctx, { request_id: 'x' })).status).toBe(400);
        (ctx.serviceRpc as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new RpcError('42501'));
        expect((await handleNotifySupport(ctx, { request_id: REQUEST_ID })).status).toBe(403);
    });
});
