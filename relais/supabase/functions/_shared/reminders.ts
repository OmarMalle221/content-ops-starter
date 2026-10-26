// Rappels quotidiens (fonction planifiée send-reminders). La base ne donne que des NOMBRES par personne
// (reminders_due) ; le courriel est générique (src/shared/reminders/email.ts). Un envoi réussi est noté
// (record_reminder_sent) : au plus un courriel par personne et par jour, même si la tâche planifiée
// tourne deux fois. Le journal ne garde que des compteurs.
import { z } from 'zod';
import { reminderEmail } from '../../../src/shared/reminders/email.ts';
import { serverLog } from './log.ts';
import type { ScheduledHandler } from './scheduled.ts';

const dueRows = z.array(
    z.object({
        user_id: z.uuid(),
        email: z.string().min(3),
        task_count: z.number().int().min(0),
        appointment_count: z.number().int().min(0)
    })
);

/** Jour au Québec (AAAA-MM-JJ) pour un instant donné. */
export const torontoDay = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

export const handleSendReminders: ScheduledHandler = async (ctx) => {
    if (!ctx.email) return { status: 503, body: { error: 'email_not_configured' } };
    const day = torontoDay(ctx.now());
    const rows = dueRows.parse(await ctx.serviceRpc<unknown>('reminders_due', { p_day: day }));
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
        const message = reminderEmail({ taskCount: row.task_count, appointmentCount: row.appointment_count }, ctx.appUrl);
        if (!message) continue;
        try {
            await ctx.email.send({ to: row.email, ...message });
        } catch (error) {
            failed += 1;
            serverLog('reminder_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
            continue;
        }
        await ctx.serviceRpc('record_reminder_sent', {
            p_user_id: row.user_id,
            p_day: day,
            p_task_count: row.task_count,
            p_appointment_count: row.appointment_count
        });
        sent += 1;
    }
    serverLog('reminders_sent', { count: sent });
    return { status: 200, body: { day, due: rows.length, sent, failed } };
};
