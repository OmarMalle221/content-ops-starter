import { NextResponse, type NextRequest } from 'next/server';
import { requestAuthGateway } from '@/server/auth/auth-gateway';
import { clientFingerprint, sessionControl } from '@/server/auth/session';
import { getApp } from '@/server/instance';
import { logger } from '@/server/logger';
import { SIGN_IN_ERROR_PATH } from '@/server/services/account-service';

/**
 * Landing of the Supabase Auth e-mail link: PKCE `code`, or `token_hash` + `type`. Always answers with a redirect
 * built on APP_URL (never on the request's Host header); every failure ends on the same generic error page.
 */
export async function GET(req: NextRequest) {
    const app = await getApp();
    let to = SIGN_IN_ERROR_PATH;
    try {
        const p = req.nextUrl.searchParams;
        const result = await app.accounts.completeSignIn(
            { gateway: await requestAuthGateway(app.config), session: sessionControl, client: await clientFingerprint() },
            { code: p.get('code'), tokenHash: p.get('token_hash'), type: p.get('type'), next: p.get('next') }
        );
        if (result.kind === 'redirect') to = result.to;
    } catch (error) {
        logger.error('auth.callback_failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
    const response = NextResponse.redirect(new URL(to, app.config.appUrl), 303);
    // The response may carry session cookies: never cache it.
    response.headers.set('cache-control', 'private, no-store');
    return response;
}
