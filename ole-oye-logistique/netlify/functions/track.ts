/**
 * GET /api/track?q=<numéro> — suivi public d'une expédition.
 *
 * Ne renvoie QUE : statut actuel, étapes (date + statut), port de départ,
 * port d'arrivée et date d'arrivée prévue. Jamais de donnée personnelle, de
 * note interne ni de prix : les colonnes lues sont listées explicitement.
 */
import type { Config, Context } from '@netlify/functions';
import { siteConfig } from '../../src/config/site.config';
import { isShipmentStatus } from '../../src/lib/statuses';
import {
  CONTAINER_RE,
  REFERENCE_RE,
  normalizeContainer,
  normalizeReference,
  type TrackingResult,
} from '../../src/lib/tracking';
import { clientIp, errorResponse, json } from '../lib/http';
import { allowRequest } from '../lib/rate-limit';
import { NotConfiguredError, serviceClient, tenantId } from '../lib/supabase';

export const config: Config = { path: '/api/track' };

/** 30 recherches par tranche de 5 minutes et par adresse IP. */
const RATE_LIMIT = { bucket: 'track', windowSeconds: 300, max: 30 };

export default async function handler(req: Request, context: Context): Promise<Response> {
  // Suivi désactivé dans la config du site : cette route n'existe pas.
  if (!siteConfig.features.tracking) return errorResponse('not_found', 404);
  if (req.method !== 'GET') return errorResponse('method_not_allowed', 405);

  const query = new URL(req.url).searchParams.get('q') ?? '';
  const reference = normalizeReference(query);
  const container = normalizeContainer(query);
  // Les deux formes ne contiennent que des lettres, des chiffres et des tirets :
  // elles peuvent être placées sans risque dans le filtre ci-dessous.
  if (!REFERENCE_RE.test(reference) || !CONTAINER_RE.test(container)) return errorResponse('invalid', 400);

  try {
    if (!(await allowRequest(clientIp(req, context), RATE_LIMIT))) return errorResponse('rate_limited', 429);

    const supabase = serviceClient();
    // Plusieurs dossiers peuvent partager un conteneur (groupage) : on prend le plus récent.
    const { data: shipment, error } = await supabase
      .from('shipments')
      .select('id, origin_port, destination_port, eta, current_status')
      .eq('tenant_id', tenantId())
      .or(`reference.eq.${reference},container_number.eq.${container}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('track: lecture refusée', error.message);
      return errorResponse('server', 500);
    }
    if (!shipment) return errorResponse('not_found', 404);

    const { data: events, error: eventsError } = await supabase
      .from('shipment_events')
      .select('status, occurred_at')
      .eq('shipment_id', shipment.id)
      .order('occurred_at', { ascending: true });
    if (eventsError) {
      console.error('track: lecture des étapes refusée', eventsError.message);
      return errorResponse('server', 500);
    }

    // La réponse est reconstruite champ par champ : rien d'autre ne peut sortir.
    const result: TrackingResult = {
      status: shipment.current_status,
      origin_port: shipment.origin_port,
      destination_port: shipment.destination_port,
      eta: shipment.eta,
      events: (events ?? [])
        .filter((event) => isShipmentStatus(event.status))
        .map((event) => ({ status: event.status, occurred_at: event.occurred_at })),
    };
    return json({ ok: true, shipment: result });
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      console.error('track:', error.message);
      return errorResponse('not_configured', 503);
    }
    console.error('track', error);
    return errorResponse('server', 500);
  }
}
