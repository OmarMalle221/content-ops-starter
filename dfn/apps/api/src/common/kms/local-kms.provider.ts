import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { kmsUnavailable, type KmsContext, type KmsProvider } from './kms-provider';

const MAGIC = Buffer.from('DFNLKMS1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Short, non-reversible fingerprint of a local master key (domain-separated SHA-256). */
export function localMasterKeyFingerprint(masterKey: Buffer): string {
  const digest = createHash('sha256').update('dfn:kms-local:fingerprint:v1:').update(masterKey).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

/**
 * Sandbox KMS: data keys are wrapped with AES-256-GCM under KMS_LOCAL_MASTER_KEY, the encryption
 * context (purpose, key id) and the master key fingerprint bound as additional data.
 *
 * Layout: `DFNLKMS1` | iv(12) | tag(16) | ciphertext(32).
 *
 * The master key lives in the environment, like the keys of ENCRYPTION_KEYRING: it separates the
 * wrapped keys (database, backups) from the key that opens them, but it is not an HSM. Production
 * deployments use the "aws" provider (or another real KMS behind the same interface).
 */
export class LocalKmsProvider implements KmsProvider {
  readonly name = 'local' as const;
  readonly keyRef: string;
  private readonly masterKey: Buffer;

  constructor(masterKeyHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error('KMS_LOCAL_MASTER_KEY must be 32-byte hex');
    this.masterKey = Buffer.from(masterKeyHex, 'hex');
    this.keyRef = localMasterKeyFingerprint(this.masterKey);
  }

  private aad(context: KmsContext): Buffer {
    return Buffer.from(`dfn-kms-local:v1:${this.keyRef}:${context.purpose}:${context.keyId}`, 'utf8');
  }

  wrap(dataKey: Buffer, context: KmsContext): Promise<Buffer> {
    if (dataKey.length !== 32) return Promise.reject(kmsUnavailable(this.name, 'wrap', 'INVALID_KEY_LENGTH'));
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(this.aad(context));
    const enc = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Promise.resolve(Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]));
  }

  unwrap(wrapped: Buffer, context: KmsContext, keyRef?: string): Promise<Buffer> {
    if (keyRef !== undefined && keyRef !== this.keyRef) {
      return Promise.reject(kmsUnavailable(this.name, 'unwrap', 'MASTER_KEY_MISMATCH'));
    }
    const head = MAGIC.length;
    if (wrapped.length !== head + IV_BYTES + TAG_BYTES + 32 || !wrapped.subarray(0, head).equals(MAGIC)) {
      return Promise.reject(kmsUnavailable(this.name, 'unwrap', 'INVALID_CIPHERTEXT'));
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.masterKey,
        wrapped.subarray(head, head + IV_BYTES),
      );
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(wrapped.subarray(head + IV_BYTES, head + IV_BYTES + TAG_BYTES));
      const key = Buffer.concat([
        decipher.update(wrapped.subarray(head + IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
      return Promise.resolve(key);
    } catch {
      // Wrong context, wrong master key or tampered bytes: GCM refuses them all alike.
      return Promise.reject(kmsUnavailable(this.name, 'unwrap', 'INVALID_CIPHERTEXT'));
    }
  }
}
