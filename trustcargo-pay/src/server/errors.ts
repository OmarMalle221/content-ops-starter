export type ErrorCode =
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'VALIDATION'
    | 'CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'MFA_REQUIRED'
    | 'RATE_LIMITED'
    | 'PROVIDER_ERROR'
    | 'INVALID_SIGNATURE'
    /** Transient: the database is busy (lock wait / statement timeout). Safe to retry later. */
    | 'UNAVAILABLE';

const STATUS: Record<ErrorCode, number> = {
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    VALIDATION: 422,
    CONFLICT: 409,
    PRECONDITION_FAILED: 412,
    MFA_REQUIRED: 403,
    RATE_LIMITED: 429,
    PROVIDER_ERROR: 502,
    INVALID_SIGNATURE: 401,
    UNAVAILABLE: 503
};

/**
 * Cross-bundle brand. Next.js may bundle this module more than once (one copy per route chunk)
 * while the application singleton lives on globalThis, so `instanceof` is unreliable: use isAppError.
 */
const APP_ERROR = Symbol.for('trustcargo.AppError');

/** Domain/application error with a stable code. `details` must never contain secrets or PII. */
export class AppError extends Error {
    readonly [APP_ERROR] = true;
    readonly status: number;
    constructor(
        readonly code: ErrorCode,
        message: string,
        readonly details?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'AppError';
        this.status = STATUS[code];
    }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'Not allowed') => new AppError('FORBIDDEN', message);
export const precondition = (message: string, details?: Record<string, unknown>) => new AppError('PRECONDITION_FAILED', message, details);

export function isAppError(error: unknown): error is AppError {
    return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[APP_ERROR] === true;
}
