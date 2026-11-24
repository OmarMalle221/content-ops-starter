/**
 * POST /api/quote — enregistre une demande de devis.
 * Valide, limite le débit, insère dans `quote_requests` puis prévient
 * l'exportateur par courriel.
 */
import type { Config, Context } from '@netlify/functions';
import { siteConfig, localeCodes } from '../../src/config/site.config';
import { HONEYPOT_FIELD, validateQuote } from '../../src/lib/quote-schema';
import { clientIp, errorResponse, isSameOrigin, json, readJson } from '../lib/http';
import { allowRequest } from '../lib/rate-limit';
import { NotConfiguredError, serviceClient, tenantId } from '../lib/supabase';
import { sendQuoteNotification } from '../lib/email';

export const config: Config = { path: '/api/quote' };

/** 5 demandes par tranche de 10 minutes et par adresse IP. */
const RATE_LIMIT = { bucket: 'quote', windowSeconds: 600, max: 5 };

export default async function handler(req: Request, context: Context): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405, {});
  if (!isSameOrigin(req)) return errorResponse('forbidden', 403);

  const body = await readJson(req);
  if (!body) return errorResponse('invalid_request', 400);

  // Champ piège rempli : c'est un robot. On répond comme si tout allait bien,
  // sans rien enregistrer, pour ne pas lui indiquer qu'il a été repéré.
  if (typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') {
    return json({ ok: true, reference: 'DV-00-00000' }, 201);
  }

  try {
    if (!(await allowRequest(clientIp(req, context), RATE_LIMIT))) return errorResponse('rate_limited', 429);

    const result = validateQuote(body, {
      destinations: siteConfig.destinations.map((d) => d.slug),
      allowOtherDestination: siteConfig.acceptsOtherDestinations,
      locales: localeCodes,
      defaultLocale: siteConfig.defaultLocale,
    });
    if (!result.ok) return errorResponse('validation', 400, { fields: result.errors });

    const { data, error } = await serviceClient()
      .from('quote_requests')
      .insert({
        ...result.data,
        tenant_id: tenantId(),
        consent_given: true,
        consent_policy_version: siteConfig.privacy.policyVersion,
      })
      .select('reference')
      .single();
    if (error || !data) {
      console.error('quote: insertion refusée', error?.message);
      return errorResponse('server', 500);
    }

    await sendQuoteNotification(result.data, data.reference);
    return json({ ok: true, reference: data.reference }, 201);
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      console.error('quote:', error.message);
      return errorResponse('not_configured', 503);
    }
    console.error('quote', error);
    return errorResponse('server', 500);
  }
}
