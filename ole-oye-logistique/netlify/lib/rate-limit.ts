import { createHash } from 'node:crypto';
import { serviceClient } from './supabase';

export interface RateLimitRule {
  /** Nom du compteur : un par fonction. */
  bucket: string;
  /** Durée de la fenêtre, en secondes. */
  windowSeconds: number;
  /** Nombre d'appels autorisés par fenêtre et par adresse IP. */
  max: number;
}

/**
 * Limite de débit simple, par adresse IP. Le compteur est tenu dans la table
 * `rate_limits` (fonction SQL `check_rate_limit`), sous forme d'empreinte :
 * l'adresse IP n'est jamais enregistrée en clair.
 *
 * En cas de panne du compteur, l'appel est autorisé : mieux vaut laisser
 * passer un abus ponctuel que perdre une vraie demande de devis.
 */
export async function allowRequest(ip: string, rule: RateLimitRule): Promise<boolean> {
  const salt = process.env.RATE_LIMIT_SALT ?? '';
  const keyHash = createHash('sha256').update(`${salt}:${ip}`).digest('hex');
  try {
    const { data, error } = await serviceClient().rpc('check_rate_limit', {
      p_bucket: rule.bucket,
      p_key_hash: keyHash,
      p_window_seconds: rule.windowSeconds,
      p_max: rule.max,
    });
    if (error) {
      console.error('rate-limit', error.message);
      return true;
    }
    return data !== false;
  } catch (error) {
    console.error('rate-limit', error);
    return true;
  }
}
