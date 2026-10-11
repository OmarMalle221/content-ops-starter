import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  S3BlobStore,
  StorageError,
  createBlobStore,
  readBodyCapped,
  s3FailureReason,
} from '../src/common/storage';
import { loadEnv } from '../src/config/env';

const s3 = mockClient(S3Client);
const MAX = 1024;
const SECRET = 'super-secret-access-key-never-logged';

function awsError(name: string, status?: number, message = `${name} (secret ${SECRET})`) {
  return Object.assign(new Error(message), {
    name,
    ...(status ? { $metadata: { httpStatusCode: status } } : {}),
  });
}

function body(bytes: Buffer, chunk = 100) {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  return Readable.from(parts) as never;
}

const b64 = (algo: 'md5' | 'sha256', bytes: Buffer) => createHash(algo).update(bytes).digest('base64');

async function rejection(promise: Promise<unknown>): Promise<StorageError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StorageError);
  return err as StorageError;
}

function newStore(maxBytes = MAX) {
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIATEST', secretAccessKey: SECRET },
  });
  return new S3BlobStore(client, { bucket: 'dfn-docs', maxBytes, endpointLabel: 'minio.local:9000' });
}

describe('S3BlobStore (aws-sdk-client-mock)', () => {
  beforeEach(() => s3.reset());
  afterAll(() => s3.restore());

  it('uploads with Content-MD5 and a SHA-256 checksum, never relying on server-side encryption', async () => {
    s3.on(PutObjectCommand).resolves({});
    const bytes = Buffer.from('DFNK2-sealed-bytes');
    await newStore().put('org-1/doc-1', bytes);
    const calls = s3.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input).toMatchObject({
      Bucket: 'dfn-docs',
      Key: 'org-1/doc-1',
      ContentLength: bytes.length,
      ContentType: 'application/octet-stream',
      ContentMD5: b64('md5', bytes),
      ChecksumSHA256: b64('sha256', bytes),
    });
    expect(input.ServerSideEncryption).toBeUndefined();
    expect(Buffer.from(input.Body as Buffer).equals(bytes)).toBe(true);
  });

  it('refuses invalid keys before any network call', async () => {
    const store = newStore();
    for (const key of ['../x', '/abs', 'A/B', 'a/b.txt', '']) {
      expect((await rejection(store.put(key, Buffer.from('x')))).reason).toBe('INVALID_KEY');
      expect((await rejection(store.get(key))).reason).toBe('INVALID_KEY');
    }
    expect(s3.calls()).toHaveLength(0);
  });

  it('streams objects into a buffer and verifies the stored SHA-256', async () => {
    const bytes = Buffer.alloc(700, 7);
    s3.on(GetObjectCommand).resolves({
      Body: body(bytes),
      ContentLength: bytes.length,
      ChecksumSHA256: b64('sha256', bytes),
    });
    const store = newStore();
    expect((await store.get('org-1/doc-1')).equals(bytes)).toBe(true);
    expect(s3.commandCalls(GetObjectCommand)[0]!.args[0].input).toMatchObject({
      Bucket: 'dfn-docs',
      Key: 'org-1/doc-1',
      ChecksumMode: 'ENABLED',
    });

    s3.on(GetObjectCommand).resolves({
      Body: body(bytes),
      ChecksumSHA256: b64('sha256', Buffer.from('other')),
    });
    const mismatch = await rejection(store.get('org-1/doc-1'));
    expect(mismatch.reason).toBe('CHECKSUM_MISMATCH');
    expect(mismatch.status).toBe(503);

    // Composite (multipart) checksums are not comparable with a full-object hash: skipped.
    s3.on(GetObjectCommand).resolves({ Body: body(bytes), ChecksumSHA256: 'abc=-3' });
    expect((await store.get('org-1/doc-1')).equals(bytes)).toBe(true);
  });

  it('enforces the size cap from the announced length and while streaming', async () => {
    const store = newStore(500);
    const big = Buffer.alloc(800, 1);
    s3.on(GetObjectCommand).resolves({ Body: body(big), ContentLength: big.length });
    expect((await rejection(store.get('org-1/doc-1'))).reason).toBe('TOO_LARGE');

    // No Content-Length: the stream is abandoned as soon as the cap is crossed.
    let pulled = 0;
    const endless = Readable.from(
      (function* () {
        for (let i = 0; i < 1000; i++) {
          pulled += 1;
          yield Buffer.alloc(100, 2);
        }
      })(),
    );
    s3.on(GetObjectCommand).resolves({ Body: endless as never });
    expect((await rejection(store.get('org-1/doc-1'))).reason).toBe('TOO_LARGE');
    expect(pulled).toBeLessThan(50);
  });

  it('reads SDK stream mixins and raw buffers too', async () => {
    const bytes = Buffer.from('mixin');
    expect(
      (await readBodyCapped({ transformToByteArray: async () => new Uint8Array(bytes) }, 10)).equals(bytes),
    ).toBe(true);
    expect((await readBodyCapped(bytes, 10)).equals(bytes)).toBe(true);
    expect((await rejection(readBodyCapped(Buffer.alloc(11), 10))).reason).toBe('TOO_LARGE');
    expect((await rejection(readBodyCapped(undefined, 10))).reason).toBe('IO_ERROR');
  });

  it('deletes idempotently and checks existence with HeadObject', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    const store = newStore();
    await store.delete('org-1/doc-1');
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toEqual({
      Bucket: 'dfn-docs',
      Key: 'org-1/doc-1',
    });
    s3.on(DeleteObjectCommand).rejects(awsError('NoSuchKey', 404));
    await expect(store.delete('org-1/doc-1')).resolves.toBeUndefined();

    s3.on(HeadObjectCommand).resolves({ ContentLength: 3 });
    expect(await store.exists('org-1/doc-1')).toBe(true);
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404));
    expect(await store.exists('org-1/doc-1')).toBe(false);
    s3.on(HeadObjectCommand).rejects(awsError('Forbidden', 403));
    expect((await rejection(store.exists('org-1/doc-1'))).reason).toBe('ACCESS_DENIED');
  });

  it('maps provider errors to STORAGE_UNAVAILABLE without echoing provider messages or credentials', async () => {
    const store = newStore();
    const cases: Array<[Error, string]> = [
      [awsError('NoSuchKey', 404), 'NOT_FOUND'],
      [awsError('AccessDenied', 403), 'ACCESS_DENIED'],
      [awsError('InvalidAccessKeyId', 403), 'ACCESS_DENIED'],
      [awsError('BadDigest', 400), 'CHECKSUM_MISMATCH'],
      // NoSuchBucket answers 404 but is a configuration problem, not a missing object.
      [awsError('NoSuchBucket', 404), 'MISCONFIGURED'],
      [awsError('InternalError', 500), 'UNREACHABLE'],
      [Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }), 'UNREACHABLE'],
      [awsError('TimeoutError'), 'UNREACHABLE'],
      [awsError('Weird', 400), 'IO_ERROR'],
    ];
    for (const [error, reason] of cases) {
      s3.on(GetObjectCommand).rejects(error);
      const err = await rejection(store.get('org-1/doc-1'));
      expect(err.reason).toBe(reason);
      expect(err.code).toBe('STORAGE_UNAVAILABLE');
      expect(err.status).toBe(503);
      expect(err.message).not.toContain(SECRET);
      expect(JSON.stringify(err.details)).not.toContain(SECRET);
    }
    expect(s3FailureReason(awsError('PermanentRedirect', 301))).toBe('MISCONFIGURED');
    s3.on(PutObjectCommand).rejects(awsError('SlowDown', 503));
    const put = await rejection(store.put('org-1/doc-1', Buffer.from('x')));
    expect(put.details).toEqual({ operation: 'put', reason: 'UNREACHABLE', driver: 's3' });
  });

  it('reports health with HeadBucket and never exposes credentials', async () => {
    const store = newStore();
    s3.on(HeadBucketCommand).resolves({});
    const ok = await store.healthCheck();
    expect(ok).toMatchObject({ driver: 's3', ok: true, location: 'dfn-docs@minio.local:9000' });
    s3.on(HeadBucketCommand).rejects(awsError('NotFound', 404));
    expect(await store.healthCheck()).toMatchObject({ ok: false, reason: 'MISCONFIGURED' });
    s3.on(HeadBucketCommand).rejects(awsError('InvalidAccessKeyId', 403));
    const denied = await store.healthCheck();
    expect(denied).toMatchObject({ ok: false, reason: 'ACCESS_DENIED' });
    expect(JSON.stringify(denied)).not.toContain(SECRET);
    expect(JSON.stringify(denied)).not.toContain('AKIATEST');
  });

  it('is built from the environment (endpoint, region, path style), and refuses a missing bucket', async () => {
    const env = loadEnv({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'dfn-docs',
      S3_ENDPOINT: 'http://minio.local:9000',
      S3_REGION: 'eu-west-3',
      S3_ACCESS_KEY_ID: 'AKIATEST',
      S3_SECRET_ACCESS_KEY: SECRET,
      S3_FORCE_PATH_STYLE: 'true',
    });
    const store = createBlobStore(env);
    expect(store).toBeInstanceOf(S3BlobStore);
    expect((store as S3BlobStore).location).toBe('dfn-docs@minio.local:9000');
    const client = (store as unknown as { client: S3Client }).client;
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe('eu-west-3');
    (store as S3BlobStore).destroy();

    const noBucket = { ...env, S3_BUCKET: undefined };
    expect(() => S3BlobStore.fromEnv(noBucket)).toThrow(StorageError);
    expect(() => createBlobStore(env, 'ftp')).toThrow(StorageError);
    loadEnv();
  });
});

/**
 * Live round trip against a real S3-compatible endpoint (MinIO, AWS…). Runs only when
 * S3_TEST_ENDPOINT is set (with S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID, S3_TEST_SECRET_ACCESS_KEY,
 * optional S3_TEST_REGION); otherwise the suite is explicitly skipped.
 */
const LIVE = Boolean(process.env.S3_TEST_ENDPOINT);
if (!LIVE) {
  console.info('[s3-store.test] live S3 suite skipped: set S3_TEST_ENDPOINT (and S3_TEST_BUCKET…) to run it');
}
describe.skipIf(!LIVE)('S3BlobStore (live endpoint, S3_TEST_ENDPOINT)', () => {
  let store: S3BlobStore;
  const key = `live-test/${randomUUID()}`;
  beforeEach(() => {
    s3.restore();
    const env = loadEnv({
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: process.env.S3_TEST_ENDPOINT!,
      S3_BUCKET: process.env.S3_TEST_BUCKET ?? 'dfn-test',
      S3_REGION: process.env.S3_TEST_REGION ?? 'us-east-1',
      S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY_ID ?? '',
      S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_ACCESS_KEY ?? '',
    });
    store = S3BlobStore.fromEnv(env);
  });
  afterEach(async () => {
    await store.delete(key).catch(() => undefined);
    store.destroy();
    loadEnv();
  });

  it('puts, reads, checks and deletes an object', async () => {
    expect((await store.healthCheck()).ok).toBe(true);
    const bytes = Buffer.from(`DFNK2 live ${randomUUID()}`);
    await store.put(key, bytes);
    expect(await store.exists(key)).toBe(true);
    expect((await store.get(key)).equals(bytes)).toBe(true);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
  });
});
