/**
 * Authentication provider port (Supabase Auth when AUTH_PROVIDER=supabase). Exactly the operations TrustCargo needs.
 *
 * An implementation is request-scoped: it reads and writes the provider's session cookies of the current request.
 * It runs server-side only (Route Handlers and Server Actions) and never hands a key or token to the browser.
 * The TrustCargo session (signed `tc_session` cookie) stays the source of truth for authorisation; the provider
 * session only proves the e-mail address and the second factor.
 */

/** Identity as confirmed by the provider's server (never decoded from a cookie alone). */
export interface VerifiedIdentity {
    authUserId: string;
    /** Lower-cased. */
    email: string;
    emailConfirmed: boolean;
}

export interface TotpFactor {
    id: string;
    verified: boolean;
    createdAt: string;
}

export interface TotpEnrolment {
    factorId: string;
    /** `data:image/svg+xml;base64,…` QR code, when the provider returned a usable SVG. */
    qrCodeDataUrl?: string;
    /** Base32 secret for manual entry. Shown to the user once; never logged. */
    secret: string;
}

export type AssuranceLevel = 'aal1' | 'aal2';

/**
 * - no_session: no (or an expired/revoked) provider session;
 * - rejected: the provider refused the request (invalid/expired link or code, unknown factor…);
 * - rate_limited: the provider throttled the request;
 * - unavailable: network error, timeout or provider 5xx.
 */
export type AuthGatewayFailure = 'no_session' | 'rejected' | 'rate_limited' | 'unavailable';

export class AuthGatewayError extends Error {
    constructor(
        readonly reason: AuthGatewayFailure,
        /** Provider error code (e.g. `otp_expired`), already restricted to a safe charset. */
        readonly providerCode?: string
    ) {
        super(`Auth provider request failed: ${reason}${providerCode ? ` (${providerCode})` : ''}`);
        this.name = 'AuthGatewayError';
    }
}

export function isAuthGatewayError(error: unknown): error is AuthGatewayError {
    return error instanceof Error && error.name === 'AuthGatewayError' && 'reason' in error;
}

export interface AuthGateway {
    /** Sends a magic link / OTP e-mail. Creates the provider account if it does not exist yet. */
    sendMagicLink(email: string, redirectTo: string): Promise<void>;
    /**
     * PKCE: exchanges the `code` of the callback URL for a provider session. The only way to sign in: the code is
     * bound to the browser that asked for the link (code verifier cookie), so a link forwarded to, or forced on,
     * another browser opens nothing there. Cross-browser `token_hash` links are deliberately not supported.
     */
    exchangeCode(code: string): Promise<void>;
    /** Identity of the current provider session, validated by the provider's server; undefined without a session. */
    currentIdentity(): Promise<VerifiedIdentity | undefined>;
    listTotpFactors(): Promise<TotpFactor[]>;
    /** Creates a new (unverified) TOTP factor. */
    enrolTotp(): Promise<TotpEnrolment>;
    /** Throws AuthGatewayError('rejected') on a wrong or expired code. */
    challengeAndVerifyTotp(factorId: string, code: string): Promise<void>;
    /** Assurance level of the current session, validated by the provider's server. */
    currentAssuranceLevel(): Promise<AssuranceLevel | undefined>;
    /** Ends the current provider session (this device only). */
    signOut(): Promise<void>;
}
