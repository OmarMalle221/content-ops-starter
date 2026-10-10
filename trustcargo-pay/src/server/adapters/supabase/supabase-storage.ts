/**
 * Supabase Storage adapter for `FileStorage` (private bucket, secret key, server-side only).
 *
 * - Objects are immutable: uploads use `upsert: false`, a new document version is a new key. The only removal is the
 *   cleanup of an upload whose unit of work failed (`delete`).
 * - The adapter never creates Supabase signed URLs. Browsers download through the application's own
 *   signed-URL route, which re-authorises the user, writes the access log and checks the SHA-256.
 * - Errors are rebuilt from the status/code only: no key, token, URL or provider message is propagated.
 */
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FileStorage } from '@/server/ports/providers';
import { DEFAULT_SUPABASE_TIMEOUT_MS, fetchWithTimeout } from './fetch';

export interface SupabaseStorageOptions {
    url: string;
    secretKey: string;
    bucket: string;
    timeoutMs?: number;
    /** Injected in tests; defaults to the global fetch. */
    fetch?: typeof fetch;
}

/**
 * Keys built by DocumentService look like '<transaction>/<logical>/v<n>-<sha>'. supabase-js does not percent-encode
 * object paths, so only URL-safe segments are accepted ('.' and '..' segments, '%', '?', '#', spaces and backslashes
 * are all rejected before any request is made).
 */
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;

export type StorageFailure = 'invalid_key' | 'conflict' | 'misconfigured' | 'rejected' | 'unavailable';

export class StorageAdapterError extends Error {
    constructor(
        readonly operation: 'upload' | 'download' | 'delete',
        readonly reason: StorageFailure,
        readonly status?: number
    ) {
        super(`Supabase Storage ${operation} failed: ${reason}${status ? ` (HTTP ${status})` : ''}`);
        this.name = 'StorageAdapterError';
    }
}

interface ErrorShape {
    status?: number;
    statusCode?: string;
    code?: string;
    message: string;
}

/** storage-js errors (StorageApiError / StorageUnknownError) are duck-typed: their classes are not re-exported by supabase-js. */
function shape(error: unknown): ErrorShape {
    const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
    return {
        status: typeof e.status === 'number' && e.status > 0 ? e.status : undefined,
        statusCode: typeof e.statusCode === 'string' ? e.statusCode : undefined,
        code: typeof e.code === 'string' ? e.code : undefined,
        message: typeof e.message === 'string' ? e.message : ''
    };
}

/** Older Storage servers answer HTTP 400 with `statusCode: "404"`; newer ones HTTP 404 with `code: "NoSuchKey"`. */
function isBucketMissing(e: ErrorShape): boolean {
    return e.code === 'NoSuchBucket' || /bucket not found/i.test(e.message);
}

function isObjectMissing(e: ErrorShape): boolean {
    if (e.code === 'NoSuchKey') return true;
    return (e.status === 404 || e.statusCode === '404') && !isBucketMissing(e);
}

function classify(e: ErrorShape): StorageFailure {
    if (e.status === 409 || e.statusCode === '409' || e.code === 'Duplicate' || e.code === 'ResourceAlreadyExists') return 'conflict';
    if (isBucketMissing(e)) return 'misconfigured';
    if (e.status === undefined || e.status >= 500 || e.status === 429) return 'unavailable';
    return 'rejected';
}

export class SupabaseFileStorage implements FileStorage {
    private readonly client: SupabaseClient;
    private readonly bucket: string;

    constructor(options: SupabaseStorageOptions) {
        this.bucket = options.bucket;
        this.client = createClient(options.url, options.secretKey, {
            // Server-to-server client: no user session is ever stored, refreshed or read from a URL.
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: fetchWithTimeout(options.timeoutMs ?? DEFAULT_SUPABASE_TIMEOUT_MS, options.fetch) }
        });
    }

    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
        if (!OBJECT_KEY.test(key)) throw new StorageAdapterError('upload', 'invalid_key');
        const { error } = await this.client.storage.from(this.bucket).upload(key, bytes, { contentType, upsert: false });
        if (error) {
            const e = shape(error);
            throw new StorageAdapterError('upload', classify(e), e.status);
        }
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        if (!OBJECT_KEY.test(key)) throw new StorageAdapterError('download', 'invalid_key');
        const { data, error } = await this.client.storage.from(this.bucket).download(key);
        if (error) {
            const e = shape(error);
            if (isObjectMissing(e)) return undefined;
            throw new StorageAdapterError('download', classify(e), e.status);
        }
        return new Uint8Array(await data.arrayBuffer());
    }

    /** Removes one object (Storage answers success for a missing one). Used to clean up after a failed upload. */
    async delete(key: string): Promise<void> {
        if (!OBJECT_KEY.test(key)) throw new StorageAdapterError('delete', 'invalid_key');
        const { error } = await this.client.storage.from(this.bucket).remove([key]);
        if (error) {
            const e = shape(error);
            throw new StorageAdapterError('delete', classify(e), e.status);
        }
    }
}
