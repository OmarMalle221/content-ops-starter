// Journal des fonctions serveur : même liste blanche de champs que l'application (règle no 5).
// Aucun contenu de document, aucun nom, aucun message d'erreur : des noms d'événements, des codes,
// des durées et des compteurs.
import { sanitizeLogFields, type LogFields } from '../../../src/lib/log.ts';

export const SERVER_LOG_EVENTS = [
    'extraction_completed',
    'extraction_failed',
    'storage_purge_failed',
    'function_error',
    'reminders_sent',
    'reminder_failed'
] as const;
export type ServerLogEvent = (typeof SERVER_LOG_EVENTS)[number];

export type ServerLogSink = (entry: Record<string, string | number>) => void;

let sink: ServerLogSink = (entry) => console.info(JSON.stringify(entry));

/** Pour les tests. */
export function setServerLogSink(next: ServerLogSink | null): void {
    sink = next ?? ((entry) => console.info(JSON.stringify(entry)));
}

export function serverLog(event: ServerLogEvent, fields: LogFields = {}): void {
    sink({ event, at: new Date().toISOString(), ...sanitizeLogFields(fields as Record<string, unknown>) });
}
