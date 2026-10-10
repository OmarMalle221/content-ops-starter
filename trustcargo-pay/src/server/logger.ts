/**
 * Structured JSON logging. Never log secrets, tokens, full account numbers or document contents.
 * In production, ship stdout to the log pipeline (e.g. Logflare / Datadog) with retention rules.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, event: string, fields: Record<string, unknown> = {}) {
    if (process.env.NODE_ENV === 'test') return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
}

export const logger = {
    debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
    info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
    error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields)
};
