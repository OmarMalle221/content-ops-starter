import { describe, expect, it } from 'vitest';
import { createFileStorage } from '@/server/adapters/storage';
import { StorageAdapterError, SupabaseFileStorage } from '@/server/adapters/supabase/supabase-storage';
import { loadConfig } from '@/server/config';

// Offline: every request goes to an injected fake fetch. Nothing here talks to a real Supabase project.
const SUPABASE_URL = 'https://project-ref.supabase.co';
const SECRET = 'unit-test-only-not-a-real-secret-key-0123456789';
const BUCKET = 'trustcargo-documents';
const KEY = '7f9c2b4e-0000-4000-8000-000000000001/1d2e3f40-0000-4000-8000-000000000002/v1-0123456789ab';

interface Call {
    method: string;
    url: URL;
    headers: Headers;
    body: unknown;
    signal?: AbortSignal | null;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function storageWith(handler: (call: Call) => Response | Promise<Response>, timeoutMs?: number) {
    const calls: Call[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body: init?.body, signal: init?.signal };
        calls.push(call);
        init?.signal?.throwIfAborted();
        return handler(call);
    };
    return { storage: new SupabaseFileStorage({ url: SUPABASE_URL, secretKey: SECRET, bucket: BUCKET, fetch, timeoutMs }), calls };
}

async function failure(promise: Promise<unknown>): Promise<StorageAdapterError> {
    const error = await promise.then(
        () => undefined,
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(StorageAdapterError);
    return error as StorageAdapterError;
}

function expectSanitized(error: Error) {
    for (const secret of [SECRET, 'Bearer', KEY, 'hunter2', SUPABASE_URL]) expect(error.message).not.toContain(secret);
}

describe('Supabase Storage adapter (fake fetch)', () => {
    it('uploads with POST to the private bucket, the secret key, the content type and upsert disabled', async () => {
        const { storage, calls } = storageWith(() => json(200, { Id: 'obj-1', Key: `${BUCKET}/${KEY}` }));
        const bytes = new Uint8Array([37, 80, 68, 70, 45]);
        await storage.put(KEY, bytes, 'application/pdf');
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call!.method).toBe('POST');
        expect(call!.url.origin).toBe(SUPABASE_URL);
        expect(call!.url.pathname).toBe(`/storage/v1/object/${BUCKET}/${KEY}`);
        expect(call!.headers.get('apikey')).toBe(SECRET);
        expect(call!.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
        expect(call!.headers.get('content-type')).toBe('application/pdf');
        expect(call!.headers.get('x-upsert')).toBe('false');
        expect(call!.body).toBe(bytes);
    });

    it('downloads with GET and returns the stored bytes', async () => {
        const { storage, calls } = storageWith(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
        expect(await storage.get(KEY)).toEqual(new Uint8Array([1, 2, 3]));
        expect(calls[0]!.method).toBe('GET');
        expect(calls[0]!.url.pathname).toBe(`/storage/v1/object/${BUCKET}/${KEY}`);
        expect(calls[0]!.headers.get('apikey')).toBe(SECRET);
    });

    it('returns undefined for a missing object (HTTP 404 and the legacy 400 + statusCode "404" answer)', async () => {
        const modern = storageWith(() =>
            json(404, { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' })
        );
        expect(await modern.storage.get(KEY)).toBeUndefined();
        const legacy = storageWith(() => json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }));
        expect(await legacy.storage.get(KEY)).toBeUndefined();
    });

    it('deletes one object of the private bucket (cleanup of a failed upload), with sanitized errors', async () => {
        const { storage, calls } = storageWith(() => json(200, [{ name: KEY }]));
        await storage.delete(KEY);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.method).toBe('DELETE');
        expect(calls[0]!.url.pathname).toBe(`/storage/v1/object/${BUCKET}`);
        expect(JSON.parse(String(calls[0]!.body))).toEqual({ prefixes: [KEY] });
        expect(calls[0]!.headers.get('apikey')).toBe(SECRET);

        const leaky = { statusCode: '500', error: 'internal', message: `db password=hunter2 for ${KEY} with Bearer ${SECRET}` };
        const error = await failure(storageWith(() => json(500, leaky)).storage.delete(KEY));
        expect([error.operation, error.reason]).toEqual(['delete', 'unavailable']);
        expectSanitized(error);
        expect((await failure(storage.delete('../etc/passwd'))).reason).toBe('invalid_key');
        expect(calls).toHaveLength(1);
    });

    it('does not mistake a missing bucket for a missing object', async () => {
        const { storage } = storageWith(() => json(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }));
        expect((await failure(storage.get(KEY))).reason).toBe('misconfigured');
    });

    it('throws a sanitized error on 5xx, auth failures and network errors', async () => {
        const leaky = { statusCode: '500', error: 'internal', message: `db password=hunter2 for ${KEY} with Bearer ${SECRET}` };
        const e500 = await failure(storageWith(() => json(500, leaky)).storage.get(KEY));
        expect(e500.reason).toBe('unavailable');
        expect(e500.status).toBe(500);
        expectSanitized(e500);

        const e403 = await failure(
            storageWith(() => json(403, { statusCode: '403', error: 'Unauthorized', message: 'invalid signature' })).storage.get(KEY)
        );
        expect(e403.reason).toBe('rejected');
        expectSanitized(e403);

        const network = await failure(
            storageWith(() => {
                throw new TypeError(`fetch failed: ${SUPABASE_URL}/storage/v1/object/${BUCKET}/${KEY}?apikey=${SECRET}`);
            }).storage.put(KEY, new Uint8Array([1]), 'image/png')
        );
        expect(network.reason).toBe('unavailable');
        expectSanitized(network);
    });

    it('refuses to overwrite an existing key (objects are immutable)', async () => {
        const { storage, calls } = storageWith(() =>
            json(409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' })
        );
        const error = await failure(storage.put(KEY, new Uint8Array([1]), 'application/pdf'));
        expect(error.reason).toBe('conflict');
        expect(calls[0]!.headers.get('x-upsert')).toBe('false');
        expectSanitized(error);
    });

    it('rejects keys that are not URL-safe before any request (supabase-js does not encode object paths)', async () => {
        const { storage, calls } = storageWith(() => json(200, {}));
        const unsafe = [
            '',
            '/abs/key',
            '../etc/passwd',
            'a/../b',
            'a/./b',
            'a//b',
            'a b',
            'a?b=1',
            'a#b',
            'a%2Fb',
            'a\\b',
            'a/b/',
            'é/x',
            'x'.repeat(200)
        ];
        for (const key of unsafe) {
            expect((await failure(storage.put(key, new Uint8Array([1]), 'application/pdf'))).reason).toBe('invalid_key');
            expect((await failure(storage.get(key))).reason).toBe('invalid_key');
        }
        expect(calls).toHaveLength(0);
    });

    it('aborts requests that exceed the timeout', async () => {
        // Never answers by itself: like the real fetch, it only rejects when the adapter's signal aborts.
        const { storage } = storageWith(
            (call) => new Promise<Response>((_, reject) => call.signal?.addEventListener('abort', () => reject(call.signal?.reason))),
            30
        );
        const error = await failure(storage.get(KEY));
        expect(error.reason).toBe('unavailable');
    });

    it('is selected by STORAGE_PROVIDER=supabase', () => {
        const config = loadConfig({
            TRUSTCARGO_MODE: 'demo',
            SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
            MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
            STORAGE_PROVIDER: 'supabase',
            SUPABASE_URL,
            SUPABASE_SECRET_KEY: SECRET
        } as unknown as NodeJS.ProcessEnv);
        expect(config.storage.bucket).toBe(BUCKET);
        expect(createFileStorage(config)).toBeInstanceOf(SupabaseFileStorage);
    });
});
