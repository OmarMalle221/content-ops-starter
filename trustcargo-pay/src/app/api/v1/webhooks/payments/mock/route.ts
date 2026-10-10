import type { NextRequest } from 'next/server';
import { getApp } from '@/server/instance';
import { json, problem } from '@/server/http/api';
import { clientIp } from '@/server/http/client-ip';
import { AppError } from '@/server/errors';
import { pseudonymize, randomToken } from '@/server/security/crypto';
import { SIGNATURE_HEADER } from '@/server/security/webhook-signature';

/**
 * Partner webhook endpoint (mock partner). Unauthenticated by session by design: authenticity comes
 * from the HMAC signature + timestamp, replay protection from the unique external event id.
 */
export async function POST(req: NextRequest) {
    const requestId = randomToken(8);
    try {
        const app = await getApp();
        const ip = clientIp(req.headers, app.config.clientIpHeader);
        if (!app.rateLimiter.consume(`webhook:${pseudonymize(app.config.sessionSecret, ip)}`, 300, 60_000).allowed)
            throw new AppError('RATE_LIMITED', 'Too many requests');
        const raw = await req.text();
        if (raw.length > 64 * 1024) throw new AppError('VALIDATION', 'Payload too large');
        const result = await app.providerEvents.ingest(raw, req.headers.get(SIGNATURE_HEADER));
        return json({ received: true, ...result });
    } catch (error) {
        return problem(error, requestId);
    }
}
