// Fonction planifiée send-reminders : nombres seulement, un courriel par personne et par jour, jour du Québec.
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailClient, EmailMessage } from '../../supabase/functions/_shared/email';
import { setServerLogSink } from '../../supabase/functions/_shared/log';
import { handleSendReminders, torontoDay } from '../../supabase/functions/_shared/reminders';
import { cronSecretMatches, type ScheduledContext } from '../../supabase/functions/_shared/scheduled';

const ROWS = [
    { user_id: 'c0000000-0000-4000-8000-00000000000c', email: 'claire@example.test', task_count: 2, appointment_count: 1 },
    { user_id: 'e0000000-0000-4000-8000-00000000000e', email: 'emma@example.test', task_count: 0, appointment_count: 1 }
];

function context(options: { failFor?: string; email?: boolean } = {}) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const sent: EmailMessage[] = [];
    const email: EmailClient = {
        send: async (message) => {
            if (message.to === options.failFor) throw Object.assign(new Error('boom claire@example.test'), { name: 'EmailError' });
            sent.push(message);
        }
    };
    const ctx: ScheduledContext = {
        serviceRpc: async <T>(fn: string, args: Record<string, unknown>) => {
            calls.push({ fn, args });
            return (fn === 'reminders_due' ? ROWS : null) as T;
        },
        removeFiles: async () => {
            throw new Error('not used');
        },
        email: options.email === false ? null : email,
        appUrl: 'https://relais.example',
        now: () => new Date('2026-11-02T03:30:00Z') // 1er novembre, 22 h 30 au Québec
    };
    return { ctx, calls, sent };
}

afterEach(() => setServerLogSink(null));

describe('send-reminders', () => {
    it('jour du Québec, un courriel par personne, envoi noté', async () => {
        const { ctx, calls, sent } = context();
        const response = await handleSendReminders(ctx);
        expect(response).toEqual({ status: 200, body: { day: '2026-11-01', due: 2, sent: 2, failed: 0 } });
        expect(calls[0]).toEqual({ fn: 'reminders_due', args: { p_day: '2026-11-01' } });
        expect(sent.map((m) => m.to)).toEqual(['claire@example.test', 'emma@example.test']);
        expect(sent[0]!.text).toContain('2 tâches à faire d’ici demain et 1 rendez-vous');
        expect(calls.filter((c) => c.fn === 'record_reminder_sent').map((c) => c.args)).toEqual([
            { p_user_id: ROWS[0]!.user_id, p_day: '2026-11-01', p_task_count: 2, p_appointment_count: 1 },
            { p_user_id: ROWS[1]!.user_id, p_day: '2026-11-01', p_task_count: 0, p_appointment_count: 1 }
        ]);
    });

    it('échec d’envoi : non noté (nouvel essai possible), journal sans adresse', async () => {
        const logs: Array<Record<string, string | number>> = [];
        setServerLogSink((entry) => logs.push(entry));
        const { ctx, calls } = context({ failFor: 'claire@example.test' });
        const response = await handleSendReminders(ctx);
        expect(response.body).toMatchObject({ sent: 1, failed: 1 });
        expect(calls.filter((c) => c.fn === 'record_reminder_sent')).toHaveLength(1);
        expect(JSON.stringify(logs)).not.toMatch(/claire|emma|example\.test/);
        expect(logs.map((l) => l.event)).toEqual(['reminder_failed', 'reminders_sent']);
    });

    it('sans fournisseur de courriel configuré : rien n’est lu', async () => {
        const { ctx, calls } = context({ email: false });
        expect(await handleSendReminders(ctx)).toEqual({ status: 503, body: { error: 'email_not_configured' } });
        expect(calls).toHaveLength(0);
    });

    it('secret de la tâche planifiée', () => {
        expect(cronSecretMatches('s3cret-value', 's3cret-value')).toBe(true);
        expect(cronSecretMatches('s3cret-value', 's3cret-valuX')).toBe(false);
        expect(cronSecretMatches('s3cret-value', 's3cret')).toBe(false);
        expect(cronSecretMatches(undefined, 's3cret-value')).toBe(false);
        expect(cronSecretMatches('s3cret-value', null)).toBe(false);
    });

    it('jour au Québec à l’heure d’hiver et d’été', () => {
        expect(torontoDay(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30');
        expect(torontoDay(new Date('2026-07-01T04:00:00Z'))).toBe('2026-07-01');
        expect(torontoDay(new Date('2026-12-01T04:59:00Z'))).toBe('2026-11-30');
    });
});
