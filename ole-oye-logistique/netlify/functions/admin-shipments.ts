/**
 * /api/admin/shipments — gestion des expéditions, réservée aux administrateurs.
 *
 *   GET  ?q=<recherche>                       → 50 dernières expéditions, avec leurs étapes
 *   POST { action: 'create', … }              → crée une expédition et sa première étape
 *   POST { action: 'add_event', … }           → ajoute une étape
 *   POST { action: 'delete_event', event_id } → retire une étape saisie par erreur
 *   POST { action: 'update', id, … }          → corrige conteneur, port d'arrivée, date prévue ou note
 */
import type { Config } from '@netlify/functions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isShipmentStatus, SHIPMENT_STATUSES } from '../../src/lib/statuses';
import { CONTAINER_RE, REFERENCE_RE, normalizeContainer, normalizeReference } from '../../src/lib/tracking';
import { errorResponse, isSameOrigin, json, readJson } from '../lib/http';
import { currentAdmin } from '../lib/session';
import { NotConfiguredError, serviceClient, tenantId } from '../lib/supabase';

export const config: Config = { path: '/api/admin/shipments' };

const SHIPMENT_COLUMNS =
  'id, reference, container_number, origin_port, destination_port, eta, current_status, internal_note, created_at, updated_at';
const EVENT_COLUMNS = 'id, shipment_id, status, occurred_at, location, source';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Date facultative : `undefined` si absente, `null` si vidée, `false` si invalide. */
function optionalDate(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(value)) ? value : false;
}

/** Conteneur facultatif : `undefined` si absent, `null` si vidé, `false` si invalide. */
function optionalContainer(value: unknown): string | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return false;
  const container = normalizeContainer(value);
  return CONTAINER_RE.test(container) ? container : false;
}

interface ShipmentRow {
  id: string;
  [column: string]: unknown;
}

/** Ajoute à chaque expédition ses étapes, de la plus ancienne à la plus récente. */
async function withEvents(supabase: SupabaseClient, shipments: ShipmentRow[]) {
  if (shipments.length === 0) return [];
  const { data: events, error } = await supabase
    .from('shipment_events')
    .select(EVENT_COLUMNS)
    .in(
      'shipment_id',
      shipments.map((shipment) => shipment.id),
    )
    .order('occurred_at', { ascending: true });
  if (error) throw new Error(error.message);
  return shipments.map((shipment) => ({
    ...shipment,
    shipment_events: (events ?? []).filter((event) => event.shipment_id === shipment.id),
  }));
}

/** Lit une expédition du tenant du site, avec ses étapes. `null` si elle n'existe pas. */
async function loadShipment(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from('shipments')
    .select(SHIPMENT_COLUMNS)
    .eq('tenant_id', tenantId())
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return (await withEvents(supabase, [data as ShipmentRow]))[0];
}

async function list(req: Request, supabase: SupabaseClient): Promise<Response> {
  // La recherche ne garde que lettres, chiffres et tirets : sans risque dans le filtre.
  const search = normalizeReference(new URL(req.url).searchParams.get('q') ?? '').replace(/[^A-Z0-9-]/g, '');
  let query = supabase
    .from('shipments')
    .select(SHIPMENT_COLUMNS)
    .eq('tenant_id', tenantId())
    .order('created_at', { ascending: false })
    .limit(50);
  if (search) {
    query = query.or(`reference.ilike.*${search}*,container_number.ilike.*${search.replace(/-/g, '')}*`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return json({ ok: true, shipments: await withEvents(supabase, (data ?? []) as ShipmentRow[]) });
}

async function create(body: Record<string, unknown>, supabase: SupabaseClient): Promise<Response> {
  const reference = normalizeReference(text(body.reference, 40));
  if (!REFERENCE_RE.test(reference)) return errorResponse('reference_required', 400);
  const container = optionalContainer(body.container_number);
  if (container === false) return errorResponse('container_invalid', 400);
  const origin_port = text(body.origin_port, 80);
  const destination_port = text(body.destination_port, 80);
  if (!origin_port || !destination_port) return errorResponse('ports_required', 400);
  const eta = optionalDate(body.eta);
  if (eta === false) return errorResponse('invalid_request', 400);

  const { data: shipment, error } = await supabase
    .from('shipments')
    .insert({
      tenant_id: tenantId(),
      reference,
      container_number: container ?? null,
      origin_port,
      destination_port,
      eta: eta ?? null,
      internal_note: text(body.internal_note, 500) || null,
      current_status: SHIPMENT_STATUSES[0],
    })
    .select('id')
    .single();
  if (error?.code === '23505') return errorResponse('reference_taken', 409);
  if (error || !shipment) throw new Error(error?.message ?? 'insertion sans résultat');

  // Première étape : « Reçu à l'entrepôt ». Sans elle, la frise publique serait vide.
  const { error: eventError } = await supabase
    .from('shipment_events')
    .insert({ shipment_id: shipment.id, status: SHIPMENT_STATUSES[0], location: origin_port, source: 'manual' });
  if (eventError) {
    await supabase.from('shipments').delete().eq('id', shipment.id);
    throw new Error(eventError.message);
  }
  return json({ ok: true, shipment: await loadShipment(supabase, shipment.id) }, 201);
}

async function addEvent(body: Record<string, unknown>, supabase: SupabaseClient): Promise<Response> {
  const shipmentId = text(body.shipment_id, 40);
  if (!UUID_RE.test(shipmentId) || !isShipmentStatus(body.status)) return errorResponse('invalid_request', 400);
  const occurredAt = text(body.occurred_at, 40);
  if (occurredAt && Number.isNaN(Date.parse(occurredAt))) return errorResponse('invalid_request', 400);

  // L'expédition doit appartenir au tenant du site.
  if (!(await loadShipment(supabase, shipmentId))) return errorResponse('not_found', 404);

  const { error } = await supabase.from('shipment_events').insert({
    shipment_id: shipmentId,
    status: body.status,
    // Sans date saisie, c'est l'horloge de la base qui date l'étape : l'ordre
    // des étapes ne dépend ainsi ni du téléphone ni du serveur de la fonction.
    ...(occurredAt ? { occurred_at: new Date(occurredAt).toISOString() } : {}),
    location: text(body.location, 120) || null,
    source: 'manual',
  });
  if (error) throw new Error(error.message);
  return json({ ok: true, shipment: await loadShipment(supabase, shipmentId) }, 201);
}

async function deleteEvent(body: Record<string, unknown>, supabase: SupabaseClient): Promise<Response> {
  const eventId = text(body.event_id, 40);
  if (!UUID_RE.test(eventId)) return errorResponse('invalid_request', 400);
  const { data: event, error } = await supabase
    .from('shipment_events')
    .select('id, shipment_id')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!event || !(await loadShipment(supabase, event.shipment_id))) return errorResponse('not_found', 404);

  const { error: deleteError } = await supabase.from('shipment_events').delete().eq('id', eventId);
  if (deleteError) throw new Error(deleteError.message);
  return json({ ok: true, shipment: await loadShipment(supabase, event.shipment_id) });
}

async function update(body: Record<string, unknown>, supabase: SupabaseClient): Promise<Response> {
  const id = text(body.id, 40);
  if (!UUID_RE.test(id)) return errorResponse('invalid_request', 400);

  const changes: Record<string, string | null> = {};
  const container = optionalContainer(body.container_number);
  if (container === false) return errorResponse('container_invalid', 400);
  if (container !== undefined) changes.container_number = container;
  const eta = optionalDate(body.eta);
  if (eta === false) return errorResponse('invalid_request', 400);
  if (eta !== undefined) changes.eta = eta;
  if (body.destination_port !== undefined) {
    const destination = text(body.destination_port, 80);
    if (!destination) return errorResponse('ports_required', 400);
    changes.destination_port = destination;
  }
  if (body.internal_note !== undefined) changes.internal_note = text(body.internal_note, 500) || null;
  if (Object.keys(changes).length === 0) return errorResponse('invalid_request', 400);

  const { data, error } = await supabase
    .from('shipments')
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId())
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return errorResponse('not_found', 404);
  return json({ ok: true, shipment: await loadShipment(supabase, id) });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    if (!(await currentAdmin(req))) return errorResponse('unauthorized', 401);
    const supabase = serviceClient();

    if (req.method === 'GET') return await list(req, supabase);
    if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);
    if (!isSameOrigin(req)) return errorResponse('forbidden', 403);

    const body = await readJson(req);
    if (!body) return errorResponse('invalid_request', 400);

    switch (body.action) {
      case 'create':
        return await create(body, supabase);
      case 'add_event':
        return await addEvent(body, supabase);
      case 'delete_event':
        return await deleteEvent(body, supabase);
      case 'update':
        return await update(body, supabase);
      default:
        return errorResponse('invalid_request', 400);
    }
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      console.error('admin-shipments:', error.message);
      return errorResponse('not_configured', 503);
    }
    console.error('admin-shipments', error);
    return errorResponse('server', 500);
  }
}
