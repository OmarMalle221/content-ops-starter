import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { Env } from '../../config/env';
import {
  kmsUnavailable,
  type KmsContext,
  type KmsFailureReason,
  type KmsOperation,
  type KmsProvider,
} from './kms-provider';

interface AwsLikeError {
  name?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

const REASONS: Readonly<Record<string, KmsFailureReason>> = {
  AccessDeniedException: 'ACCESS_DENIED',
  UnrecognizedClientException: 'ACCESS_DENIED',
  InvalidSignatureException: 'ACCESS_DENIED',
  ExpiredTokenException: 'ACCESS_DENIED',
  CredentialsProviderError: 'NO_CREDENTIALS',
  NotFoundException: 'KEY_NOT_FOUND',
  DisabledException: 'KEY_DISABLED',
  KMSInvalidStateException: 'KEY_DISABLED',
  InvalidKeyUsageException: 'KEY_DISABLED',
  InvalidCiphertextException: 'INVALID_CIPHERTEXT',
  // Decrypt is pinned to KMS_KEY_ID: KMS answers this when the ciphertext was produced under
  // another key, i.e. the configured master key no longer matches the recorded data keys.
  IncorrectKeyException: 'MASTER_KEY_MISMATCH',
  ThrottlingException: 'THROTTLED',
  LimitExceededException: 'THROTTLED',
  KeyUnavailableException: 'UNREACHABLE',
  DependencyTimeoutException: 'UNREACHABLE',
  KMSInternalException: 'UNREACHABLE',
  TimeoutError: 'UNREACHABLE',
  RequestTimeout: 'UNREACHABLE',
  NetworkingError: 'UNREACHABLE',
};
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);

/** Maps an AWS SDK / network error to a stable reason (never echoes the provider's message). */
export function awsKmsFailureReason(err: unknown): KmsFailureReason {
  const e = (err ?? {}) as AwsLikeError;
  const byName = e.name ? REASONS[e.name] : undefined;
  if (byName) return byName;
  if (e.code && NETWORK_CODES.has(e.code)) return 'UNREACHABLE';
  const status = e.$metadata?.httpStatusCode;
  if (status === 401 || status === 403) return 'ACCESS_DENIED';
  if (status !== undefined && status >= 500) return 'UNREACHABLE';
  return 'ERROR';
}

export interface AwsKmsProviderOptions {
  client: KMSClient;
  /** Key id, ARN or alias new data keys are wrapped with (KMS_KEY_ID). */
  keyId: string;
}

/**
 * AWS KMS (or a compatible service through KMS_ENDPOINT): data keys are wrapped with Encrypt and
 * unwrapped with Decrypt on the symmetric key KMS_KEY_ID, with the EncryptionContext
 * `{ purpose, keyId }` (authenticated by KMS and recorded in CloudTrail). Decrypt is pinned to
 * KMS_KEY_ID: a ciphertext produced under any other key (e.g. a row planted by someone who can
 * write to the database but not use this key, or KMS_KEY_ID pointed at a different key) is refused
 * by KMS with IncorrectKeyException, reported as MASTER_KEY_MISMATCH. The reference recorded on a
 * row is not used for Decrypt — an alias and the ARN of the same key are equally valid there.
 * Credentials come from the default AWS provider chain (instance / task role, environment, SSO
 * profile…).
 */
export class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws' as const;
  readonly keyRef: string;
  private readonly client: KMSClient;

  constructor(options: AwsKmsProviderOptions) {
    this.client = options.client;
    this.keyRef = options.keyId;
  }

  static fromEnv(env: Pick<Env, 'KMS_KEY_ID' | 'KMS_REGION' | 'KMS_ENDPOINT'>): AwsKmsProvider {
    if (!env.KMS_KEY_ID || !env.KMS_REGION) throw new Error('KMS_KEY_ID and KMS_REGION are required');
    const client = new KMSClient({
      region: env.KMS_REGION,
      endpoint: env.KMS_ENDPOINT || undefined,
      maxAttempts: 3,
      // Bounded calls: a hung KMS must not stall a boot, a refresh or an admin request forever.
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    });
    return new AwsKmsProvider({ client, keyId: env.KMS_KEY_ID });
  }

  private fail(operation: KmsOperation, err: unknown): never {
    throw kmsUnavailable(this.name, operation, awsKmsFailureReason(err));
  }

  async wrap(dataKey: Buffer, context: KmsContext): Promise<Buffer> {
    if (dataKey.length !== 32) throw kmsUnavailable(this.name, 'wrap', 'INVALID_KEY_LENGTH');
    let blob: Uint8Array | undefined;
    try {
      const out = await this.client.send(
        new EncryptCommand({
          KeyId: this.keyRef,
          Plaintext: dataKey,
          EncryptionContext: { purpose: context.purpose, keyId: context.keyId },
        }),
      );
      blob = out.CiphertextBlob;
    } catch (err) {
      this.fail('wrap', err);
    }
    if (!blob?.length) throw kmsUnavailable(this.name, 'wrap', 'ERROR');
    return Buffer.from(blob);
  }

  async unwrap(wrapped: Buffer, context: KmsContext): Promise<Buffer> {
    let plaintext: Uint8Array | undefined;
    try {
      const out = await this.client.send(
        new DecryptCommand({
          KeyId: this.keyRef,
          CiphertextBlob: wrapped,
          EncryptionContext: { purpose: context.purpose, keyId: context.keyId },
        }),
      );
      plaintext = out.Plaintext;
    } catch (err) {
      this.fail('unwrap', err);
    }
    if (plaintext?.length !== 32) {
      plaintext?.fill(0);
      throw kmsUnavailable(this.name, 'unwrap', 'INVALID_KEY_LENGTH');
    }
    const key = Buffer.from(plaintext);
    plaintext.fill(0);
    return key;
  }
}
