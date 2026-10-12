import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageDriver } from '@dfn/shared';
import type { Env } from '../../config/env';
import {
  StorageError,
  assertValidStorageKey,
  MAX_UPLOAD_HARD_MB,
  maxSealedBytes,
  type BlobMeta,
  type BlobStore,
  type StorageFailureReason,
  type StorageHealth,
  type StorageOperation,
} from './blob-store';

export interface S3BlobStoreOptions {
  bucket: string;
  /** Largest object `get` accepts (sealed bytes); bigger objects are refused before buffering. */
  maxBytes: number;
  /** Endpoint host shown in health reports (never credentials). */
  endpointLabel?: string;
}

interface AwsLikeError {
  name?: string;
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

const NOT_FOUND_NAMES = new Set(['NoSuchKey', 'NotFound', 'NoSuchVersion']);
const ACCESS_NAMES = new Set([
  'AccessDenied',
  'Forbidden',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'CredentialsProviderError',
]);
const CHECKSUM_NAMES = new Set([
  'BadDigest',
  'InvalidDigest',
  'XAmzContentSHA256Mismatch',
  'InvalidChecksum',
  'ChecksumMismatch',
]);
const CONFIG_NAMES = new Set(['NoSuchBucket', 'PermanentRedirect', 'AuthorizationHeaderMalformed']);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'TimeoutError',
  'RequestTimeout',
  'NetworkingError',
]);

/** Maps an AWS SDK / network error to a storage failure reason (never echoes provider messages). */
export function s3FailureReason(err: unknown): StorageFailureReason {
  const e = (err ?? {}) as AwsLikeError;
  const name = e.name ?? e.Code ?? '';
  const code = e.code ?? '';
  const status = e.$metadata?.httpStatusCode;
  // A missing bucket also answers 404: check configuration errors before "object not found".
  if (CONFIG_NAMES.has(name) || status === 301) return 'MISCONFIGURED';
  if (NOT_FOUND_NAMES.has(name) || status === 404) return 'NOT_FOUND';
  if (CHECKSUM_NAMES.has(name)) return 'CHECKSUM_MISMATCH';
  if (ACCESS_NAMES.has(name) || status === 401 || status === 403) return 'ACCESS_DENIED';
  if (NETWORK_CODES.has(name) || NETWORK_CODES.has(code) || (status !== undefined && status >= 500)) {
    return 'UNREACHABLE';
  }
  return 'IO_ERROR';
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return !!value && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

/**
 * Buffers a GetObject body while enforcing `maxBytes`: the stream is abandoned (and destroyed by
 * the async iterator) as soon as the cap is crossed, so an oversized object never fills memory.
 */
export async function readBodyCapped(body: unknown, maxBytes: number): Promise<Buffer> {
  if (body === undefined || body === null) throw new StorageError('get', 'IO_ERROR', StorageDriver.S3);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (body.length > maxBytes) throw new StorageError('get', 'TOO_LARGE', StorageDriver.S3);
    return Buffer.from(body);
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) throw new StorageError('get', 'TOO_LARGE', StorageDriver.S3);
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }
  const mixin = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof mixin.transformToByteArray === 'function') {
    const bytes = await mixin.transformToByteArray();
    if (bytes.length > maxBytes) throw new StorageError('get', 'TOO_LARGE', StorageDriver.S3);
    return Buffer.from(bytes);
  }
  throw new StorageError('get', 'IO_ERROR', StorageDriver.S3);
}

/**
 * Blobs in an S3-compatible bucket (AWS S3, MinIO, Ceph RGW, Scaleway, OVH…), AWS SDK v3.
 *
 *  - uploads carry Content-MD5 and x-amz-checksum-sha256: the provider rejects bytes damaged in
 *    transit (BadDigest) instead of storing them;
 *  - downloads ask for the stored checksum (ChecksumMode=ENABLED) and verify it when the provider
 *    returns a full-object SHA-256; the body is streamed into memory under a size cap;
 *  - server-side encryption is deliberately NOT relied upon: blobs are sealed by the key ring
 *    before they reach this class, so a leaked bucket or a misconfigured ACL exposes ciphertext only.
 */
export class S3BlobStore implements BlobStore {
  readonly driver = StorageDriver.S3;

  constructor(
    private readonly client: S3Client,
    private readonly options: S3BlobStoreOptions,
  ) {}

  /** Builds the client from the environment. Credentials fall back to the default AWS chain. */
  static fromEnv(env: Env): S3BlobStore {
    if (!env.S3_BUCKET) throw new StorageError('resolve', 'MISCONFIGURED', StorageDriver.S3);
    const client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
      // Checksums are supplied explicitly (below); do not let the SDK add CRC32 trailers that some
      // S3-compatible providers reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
    let endpointLabel = 'aws';
    if (env.S3_ENDPOINT) {
      try {
        endpointLabel = new URL(env.S3_ENDPOINT).host;
      } catch {
        endpointLabel = 'custom-endpoint';
      }
    }
    return new S3BlobStore(client, {
      bucket: env.S3_BUCKET,
      maxBytes: maxSealedBytes(MAX_UPLOAD_HARD_MB),
      endpointLabel,
    });
  }

  get location(): string {
    return `${this.options.bucket}@${this.options.endpointLabel ?? 'aws'}`;
  }

  private fail(operation: StorageOperation, err: unknown): never {
    if (err instanceof StorageError) throw err;
    throw new StorageError(operation, s3FailureReason(err), this.driver);
  }

  async put(key: string, bytes: Buffer, meta?: BlobMeta): Promise<void> {
    assertValidStorageKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: meta?.contentType ?? 'application/octet-stream',
          ContentMD5: createHash('md5').update(bytes).digest('base64'),
          ChecksumSHA256: sha256Base64(bytes),
        }),
      );
    } catch (err) {
      this.fail('put', err);
    }
  }

  async get(key: string): Promise<Buffer> {
    assertValidStorageKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      if (res.ContentLength !== undefined && res.ContentLength > this.options.maxBytes) {
        const body = res.Body as { destroy?: () => void } | undefined;
        body?.destroy?.();
        throw new StorageError('get', 'TOO_LARGE', this.driver);
      }
      const bytes = await readBodyCapped(res.Body, this.options.maxBytes);
      // Full-object SHA-256 (composite multipart checksums end with "-<parts>" and are skipped).
      const stored = res.ChecksumSHA256;
      if (stored && !stored.includes('-') && stored !== sha256Base64(bytes)) {
        throw new StorageError('get', 'CHECKSUM_MISMATCH', this.driver);
      }
      return bytes;
    } catch (err) {
      this.fail('get', err);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidStorageKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (err) {
      if (s3FailureReason(err) === 'NOT_FOUND') return;
      this.fail('delete', err);
    }
  }

  async exists(key: string): Promise<boolean> {
    assertValidStorageKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return true;
    } catch (err) {
      if (s3FailureReason(err) === 'NOT_FOUND') return false;
      this.fail('exists', err);
    }
  }

  async healthCheck(): Promise<StorageHealth> {
    const started = performance.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
      return {
        driver: this.driver,
        ok: true,
        latencyMs: Math.round(performance.now() - started),
        location: this.location,
      };
    } catch (err) {
      const reason = s3FailureReason(err);
      return {
        driver: this.driver,
        ok: false,
        latencyMs: Math.round(performance.now() - started),
        location: this.location,
        // HeadBucket answers 404 for a bucket that does not exist: a configuration problem.
        reason: reason === 'NOT_FOUND' ? 'MISCONFIGURED' : reason,
      };
    }
  }

  /** Releases the HTTP agent (tests, shutdown). */
  destroy(): void {
    this.client.destroy();
  }
}
