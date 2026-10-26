// Bilan de la semaine de l'aidant : 3 questions notées de 1 à 5. Pas un outil clinique : il sert seulement à
// proposer du répit et une intervenante quand la semaine semble lourde.
// Seuil PROPOSÉ, à valider par la travailleuse sociale (B4) : total de 12 ou plus, ou une réponse à 5.

export const CHECKIN_QUESTIONS = ['fatigue', 'overwhelm', 'isolation'] as const;
export type CheckinQuestion = (typeof CHECKIN_QUESTIONS)[number];
export type CheckinAnswers = Record<CheckinQuestion, number>;

export const CHECKIN_THRESHOLD = { total: 12, single: 5 } as const;

export function checkinTotal(answers: CheckinAnswers): number {
    return CHECKIN_QUESTIONS.reduce((sum, q) => sum + answers[q], 0);
}

/** Vrai si la semaine semble lourde : on propose du répit et une intervenante. */
export function needsSupport(answers: CheckinAnswers): boolean {
    return checkinTotal(answers) >= CHECKIN_THRESHOLD.total || CHECKIN_QUESTIONS.some((q) => answers[q] >= CHECKIN_THRESHOLD.single);
}

export function isValidAnswers(answers: Partial<Record<CheckinQuestion, number | null>>): answers is CheckinAnswers {
    return CHECKIN_QUESTIONS.every((q) => {
        const value = answers[q];
        return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
    });
}

/** Lundi de la semaine en cours au Québec (AAAA-MM-JJ). */
export function weekStart(now: Date = new Date()): string {
    const day = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
    const date = new Date(`${day}T12:00:00Z`);
    const isoDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    date.setUTCDate(date.getUTCDate() - (isoDay - 1));
    return date.toISOString().slice(0, 10);
}
