// Courriel de rappel quotidien : contenu GÉNÉRIQUE (règle no 5 et consentement « Rappels par courriel »).
// Il ne reçoit que des nombres : aucun titre de tâche, aucun nom, aucun lieu, aucun renseignement de
// santé ne peut s'y retrouver.

export interface ReminderCounts {
    taskCount: number;
    appointmentCount: number;
}

export interface ReminderEmail {
    subject: string;
    text: string;
    html: string;
}

export const REMINDER_SUBJECT = 'Relais : votre rappel du jour';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Phrase de rappel, ou null s'il n'y a rien à rappeler. */
export function reminderSentence({ taskCount, appointmentCount }: ReminderCounts): string | null {
    const parts = [
        ...(taskCount > 0 ? [`${plural(taskCount, 'tâche', 'tâches')} à faire d’ici demain`] : []),
        ...(appointmentCount > 0 ? [`${plural(appointmentCount, 'rendez-vous', 'rendez-vous')} aujourd’hui ou demain`] : [])
    ];
    return parts.length === 0 ? null : `Vous avez ${parts.join(' et ')} dans Relais.`;
}

const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function reminderEmail(counts: ReminderCounts, appUrl: string): ReminderEmail | null {
    const sentence = reminderSentence(counts);
    if (!sentence) return null;
    const link = `${appUrl.replace(/\/+$/, '')}/accueil`;
    const privacy = 'Ce courriel ne contient aucun renseignement sur votre proche.';
    const stop = 'Pour ne plus recevoir ces rappels : dans Relais, « Mes consentements », puis « Rappels par courriel ».';
    const text = ['Bonjour,', '', sentence, '', `Ouvrir Relais : ${link}`, '', privacy, stop, ''].join('\n');
    const html = [
        '<!doctype html>',
        '<html lang="fr-CA"><head><meta charset="utf-8"><title>Relais</title></head>',
        '<body style="font-family: Arial, sans-serif; font-size: 18px; line-height: 1.5; color: #1a1a1a;">',
        '<p>Bonjour,</p>',
        `<p>${escapeHtml(sentence)}</p>`,
        `<p><a href="${escapeHtml(link)}" style="color: #0e5258; font-weight: bold;">Ouvrir Relais</a></p>`,
        `<p style="font-size: 16px; color: #4a4a4a;">${escapeHtml(privacy)}<br>${escapeHtml(stop)}</p>`,
        '</body></html>'
    ].join('\n');
    return { subject: REMINDER_SUBJECT, text, html };
}
