// Champs autorisés dans les journaux, communs à l'application et aux fonctions serveur (règle no 5).
// Seuls des champs techniques passent : identifiants, codes, durées, compteurs. Aucun texte libre, aucun
// message d'erreur (il peut contenir des valeurs saisies), aucune donnée de santé. Tout champ inconnu est
// retiré, toute valeur suspecte est remplacée. Sans dépendance à Vite : ce fichier tourne aussi sous Deno.

export interface LogFields {
    route?: string;
    status?: number;
    code?: string;
    errorName?: string;
    durationMs?: number;
    count?: number;
    level?: string;
}

const ALLOWED_FIELDS = new Set<keyof LogFields>(['route', 'status', 'code', 'errorName', 'durationMs', 'count', 'level']);
// Valeurs textuelles : jetons techniques courts seulement (ex. « 23505 », « AuthApiError », « /compte »).
const SAFE_TOKEN = /^[A-Za-z0-9_./:-]{1,64}$/;

export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (!ALLOWED_FIELDS.has(key as keyof LogFields)) continue;
        if (typeof value === 'number' && Number.isFinite(value)) {
            out[key] = value;
        } else if (typeof value === 'string') {
            out[key] = SAFE_TOKEN.test(value) ? value : '[redacted]';
        }
    }
    return out;
}
