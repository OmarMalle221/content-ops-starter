/**
 * Statuts normalisés d'une expédition, dans l'ordre du parcours.
 * Les libellés traduits sont dans `src/i18n/*.json` (clé `statuses`).
 * Garder cette liste identique au domaine SQL `shipment_status`.
 */
export const SHIPMENT_STATUSES = [
  'received_at_warehouse',
  'loaded_in_container',
  'delivered_to_port',
  'on_board',
  'arrived_at_destination',
  'available_delivered',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export function isShipmentStatus(value: unknown): value is ShipmentStatus {
  return typeof value === 'string' && (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

/** Statut suivant dans le parcours, ou `null` si l'expédition est terminée. */
export function nextStatus(current: ShipmentStatus): ShipmentStatus | null {
  const index = SHIPMENT_STATUSES.indexOf(current);
  return SHIPMENT_STATUSES[index + 1] ?? null;
}
