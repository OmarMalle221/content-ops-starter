// Fonctions planifiées (pg_cron → pg_net) : send-reminders, purge-storage. Pas d'utilisateur : un secret
// partagé (RELAIS_CRON_SECRET) dans l'en-tête x-relais-cron-secret, et la clé serveur pour la base.
import type { EmailClient } from './email.ts';
import type { HandlerResponse } from './handlers.ts';

export interface ScheduledContext {
    /** Appel avec la clé serveur (fonctions réservées au rôle service). */
    serviceRpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
    /** Efface des fichiers du bucket `documents` (API Storage). */
    removeFiles(paths: string[]): Promise<void>;
    email: EmailClient | null;
    appUrl: string;
    now(): Date;
}

export type ScheduledHandler = (ctx: ScheduledContext) => Promise<HandlerResponse>;

/** Secret partagé avec la tâche planifiée, comparé en temps constant. */
export function cronSecretMatches(expected: string | undefined, received: string | null): boolean {
    if (!expected || !received) return false;
    const a = new TextEncoder().encode(expected);
    const b = new TextEncoder().encode(received);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
}
