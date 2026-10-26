// Journaliseur applicatif à liste blanche (règle non négociable no 5).
//
// Seuls des noms d'événements connus et des champs techniques passent (filtre commun avec les fonctions
// serveur : src/shared/log/fields.ts). Aucun texte libre, aucun message d'erreur, aucune donnée de santé.
import { sanitizeLogFields, type LogFields } from '../shared/log/fields';

export { sanitizeLogFields, type LogFields };

export const LOG_EVENTS = [
    'app_started',
    'auth_code_requested',
    'auth_code_verified',
    'auth_failed',
    'mfa_verified',
    'consent_granted',
    'consent_revoked',
    'export_downloaded',
    'account_deleted',
    'distress_screen_shown',
    'resources_fallback_used',
    'api_error',
    'unhandled_error'
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

export type LogSink = (entry: Record<string, string | number>) => void;

const consoleSink: LogSink = (entry) => {
    if (import.meta.env.DEV) console.info('[relais]', entry);
};
let sink: LogSink = consoleSink;

/** Pour les tests, ou pour brancher un collecteur plus tard. */
export function setLogSink(next: LogSink | null): void {
    sink = next ?? consoleSink;
}

export function logEvent(event: LogEvent, fields: LogFields = {}): void {
    if (!(LOG_EVENTS as readonly string[]).includes(event)) return;
    sink({ event, at: new Date().toISOString(), ...sanitizeLogFields(fields as Record<string, unknown>) });
}

/** Nom et code d'une erreur, sans son message. */
export function errorFields(error: unknown): Pick<LogFields, 'errorName' | 'code' | 'status'> {
    if (typeof error !== 'object' || error === null) return { errorName: typeof error };
    const e = error as { name?: unknown; code?: unknown; status?: unknown };
    return {
        errorName: typeof e.name === 'string' ? e.name : 'Error',
        ...(typeof e.code === 'string' ? { code: e.code } : {}),
        ...(typeof e.status === 'number' ? { status: e.status } : {})
    };
}
