/**
 * Point de branchement pour le suivi automatique par les compagnies maritimes
 * (Maersk, CMA CGM, MSC…). Rien n'est implémenté pour l'instant : toutes les
 * étapes sont saisies à la main dans /admin, avec `source = 'manual'`.
 *
 * Pour brancher un transporteur plus tard :
 *
 * 1. Créer un fichier par compagnie dans ce dossier (ex. `maersk.ts`) qui
 *    implémente `CarrierAdapter`. La clé d'API se lit dans une variable
 *    d'environnement Netlify (ex. `MAERSK_API_KEY`), jamais dans le dépôt.
 * 2. Créer une fonction planifiée Netlify (ex. `netlify/functions/carrier-sync.ts`,
 *    avec `export const config = { schedule: '@hourly' }`) qui, pour chaque
 *    expédition non terminée ayant un numéro de conteneur :
 *      a. choisit l'adaptateur avec `supports(containerNumber)` ;
 *      b. appelle `fetchEvents(containerNumber)` ;
 *      c. insère dans `shipment_events` les étapes absentes, avec
 *         `source = 'carrier_api'` et la réponse d'origine dans `raw_payload` ;
 *      d. met à jour `shipments.eta` si le transporteur en fournit une.
 *    Le déclencheur SQL recalcule `shipments.current_status` tout seul.
 * 3. Aucun changement côté site : la page de suivi lit les mêmes tables.
 */
import type { ShipmentStatus } from '../../../src/lib/statuses';

/** Une étape rapportée par un transporteur, traduite dans nos statuts normalisés. */
export interface CarrierEvent {
  status: ShipmentStatus;
  /** Date de l'étape, au format ISO 8601. */
  occurredAt: string;
  /** Lieu rapporté par le transporteur (port, terminal, navire). */
  location?: string;
  /** Réponse d'origine du transporteur, conservée telle quelle dans `raw_payload`. */
  rawPayload: unknown;
}

export interface CarrierTracking {
  events: CarrierEvent[];
  /** Date d'arrivée prévue (AAAA-MM-JJ), si le transporteur la fournit. */
  eta?: string;
}

export interface CarrierAdapter {
  /** Nom du transporteur, pour les journaux (ex. « maersk »). */
  readonly name: string;

  /**
   * Indique si ce transporteur gère ce conteneur, en général d'après le
   * préfixe du numéro (ex. MSKU ou MAEU pour Maersk, CMAU pour CMA CGM, MSCU pour MSC).
   */
  supports(containerNumber: string): boolean;

  /**
   * Interroge l'API du transporteur et renvoie les étapes connues.
   * Les événements du transporteur sans équivalent dans nos statuts sont ignorés.
   * Doit lever une erreur en cas d'échec réseau ou d'authentification.
   */
  fetchEvents(containerNumber: string): Promise<CarrierTracking>;
}

/** Adaptateurs actifs. Vide tant qu'aucun transporteur n'est branché. */
export const carrierAdapters: CarrierAdapter[] = [];
