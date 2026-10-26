// Avis aux intervenantes d'une nouvelle demande : AUCUN contenu (ni nom, ni message, ni coordonnées).
// Seulement l'origine, pour aider à prioriser (l'écran d'urgence d'abord), et le lien vers le tableau.
import type { ReminderEmail } from '../reminders/email';

export type SupportOrigin = 'button' | 'distress_screen' | 'checkin';

const ORIGIN_LABELS: Record<SupportOrigin, string> = {
    button: 'bouton « Parler à une intervenante »',
    distress_screen: 'écran d’urgence',
    checkin: 'bilan de la semaine'
};

const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function supportNotificationEmail(origin: SupportOrigin, appUrl: string): ReminderEmail {
    const urgent = origin === 'distress_screen';
    const link = `${appUrl.replace(/\/+$/, '')}/intervenante`;
    const subject = urgent ? 'Relais : nouvelle demande (écran d’urgence)' : 'Relais : nouvelle demande d’intervenante';
    const lines = [
        'Bonjour,',
        '',
        `Une nouvelle demande attend dans le tableau de suivi de Relais (origine : ${ORIGIN_LABELS[origin]}).`,
        '',
        `Ouvrir le tableau : ${link}`,
        '',
        'Ce courriel ne contient aucun renseignement sur la personne. Connexion avec vérification en deux étapes.',
        ''
    ];
    const html = [
        '<!doctype html>',
        '<html lang="fr-CA"><head><meta charset="utf-8"><title>Relais</title></head>',
        '<body style="font-family: Arial, sans-serif; font-size: 18px; line-height: 1.5; color: #1a1a1a;">',
        ...lines
            .filter((l) => l !== '')
            .map((l) =>
                l.startsWith('Ouvrir le tableau')
                    ? `<p><a href="${escapeHtml(link)}" style="color: #0e5258; font-weight: bold;">Ouvrir le tableau de suivi</a></p>`
                    : `<p>${escapeHtml(l)}</p>`
            ),
        '</body></html>'
    ].join('\n');
    return { subject, text: lines.join('\n'), html };
}
