// Courriel de rappel : contenu générique, seulement des nombres et un lien (aucune donnée de santé).
import { describe, expect, it } from 'vitest';
import { REMINDER_SUBJECT, reminderEmail, reminderSentence } from '../../src/shared/reminders/email';

const APP = 'https://relais.example/';

describe('courriel de rappel', () => {
    it('phrases selon les nombres (singulier, pluriel, combinaison)', () => {
        expect(reminderSentence({ taskCount: 1, appointmentCount: 0 })).toBe('Vous avez 1 tâche à faire d’ici demain dans Relais.');
        expect(reminderSentence({ taskCount: 2, appointmentCount: 1 })).toBe(
            'Vous avez 2 tâches à faire d’ici demain et 1 rendez-vous aujourd’hui ou demain dans Relais.'
        );
        expect(reminderSentence({ taskCount: 0, appointmentCount: 3 })).toBe('Vous avez 3 rendez-vous aujourd’hui ou demain dans Relais.');
        expect(reminderEmail({ taskCount: 0, appointmentCount: 0 }, APP)).toBeNull();
    });

    it('contenu entièrement fixe : seuls les nombres changent', () => {
        const a = reminderEmail({ taskCount: 2, appointmentCount: 1 }, APP)!;
        const b = reminderEmail({ taskCount: 7, appointmentCount: 4 }, APP)!;
        expect(a.subject).toBe(REMINDER_SUBJECT);
        const skeleton = (s: string) => s.replace(/\d+/g, '#').replace(/tâches?/g, 'tâche');
        expect(skeleton(a.text)).toBe(skeleton(b.text));
        expect(skeleton(a.html)).toBe(skeleton(b.html));
        expect(a.text).toBe(
            [
                'Bonjour,',
                '',
                'Vous avez 2 tâches à faire d’ici demain et 1 rendez-vous aujourd’hui ou demain dans Relais.',
                '',
                'Ouvrir Relais : https://relais.example/accueil',
                '',
                'Ce courriel ne contient aucun renseignement sur votre proche.',
                'Pour ne plus recevoir ces rappels : dans Relais, « Mes consentements », puis « Rappels par courriel ».',
                ''
            ].join('\n')
        );
    });

    it('HTML en français, lien échappé', () => {
        const email = reminderEmail({ taskCount: 1, appointmentCount: 0 }, 'https://relais.example/?a="b"')!;
        expect(email.html).toContain('<html lang="fr-CA">');
        expect(email.html).toContain('href="https://relais.example/?a=&quot;b&quot;/accueil"');
        expect(email.html).not.toContain('"b"');
    });
});
