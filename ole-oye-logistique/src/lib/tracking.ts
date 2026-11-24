/**
 * Règles de saisie des numéros de dossier et de conteneur, partagées par le
 * site, l'administration et les fonctions serveur.
 */
import type { ShipmentStatus } from './statuses';

/** Numéro de dossier : 4 à 30 lettres, chiffres ou tirets. */
export const REFERENCE_RE = /^[A-Z0-9][A-Z0-9-]{3,29}$/;
/** Numéro de conteneur : 4 à 30 lettres ou chiffres (ex. MSCU1234567). */
export const CONTAINER_RE = /^[A-Z0-9]{4,30}$/;

/** Met un numéro de dossier en forme : majuscules, sans espace. */
export function normalizeReference(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

/** Met un numéro de conteneur en forme : majuscules, sans espace ni tiret. */
export function normalizeContainer(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/** Réponse publique du suivi. Ne contient ni donnée personnelle, ni prix. */
export interface TrackingResult {
  status: ShipmentStatus;
  origin_port: string;
  destination_port: string;
  eta: string | null;
  events: { status: ShipmentStatus; occurred_at: string }[];
}
