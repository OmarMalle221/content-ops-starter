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
    | 'INVALID_SIGNATURE';

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
    INVALID_SIGNATURE: 401
};

/** Domain/application error with a stable code. `details` must never contain secrets or PII. */
export class AppError extends Error {
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
