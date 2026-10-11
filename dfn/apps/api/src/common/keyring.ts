import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyPurpose } from '@dfn/shared';
import type { Env } from '../config/env';

/**
 * Key ring — one AES-256-GCM key per purpose (documents, MFA secrets, webhook secrets,
 * beneficiary identifiers), several versions per purpose to allow rotation.
 *
 * Formats (the purpose and key id are bound as GCM additional data, so a ciphertext cannot be
 * replayed under another purpose or key):
 *  - sealed string: `k2.<purpose>.<keyId>.<base64(iv | tag | ciphertext)>`
 *  - sealed buffer: `DFNK2` | keyIdLength (1 byte) | keyId | iv(12) | tag(16) | ciphertext
 * Legacy values (phases 0–5) carry no header: they were sealed with DOCUMENT_ENCRYPTION_KEY
 * (`iv | tag | ciphertext`, strings in base64) and remain readable under the key id "legacy".
 */
export const LEGACY_KEY_ID = 'legacy';
const STRING_PREFIX = 'k2';
const BUFFER_MAGIC = Buffer.from('DFNK2', 'ascii');
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PURPOSES = new Set<string>(Object.values(KeyPurpose));

interface KeyEntry {
  purpose: KeyPurpose;
  keyId: string;
  key: Buffer;
}

export class KeyRingError extends Error {}

function aad(purpose: string, keyId: string): Buffer {
  return Buffer.from(`${purpose}:${keyId}`, 'utf8');
}

function seal(key: Buffer, plaintext: Buffer, additional: Buffer | null): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (additional) cipher.setAAD(additional);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function open(key: Buffer, payload: Buffer, additional: Buffer | null): Buffer {
  if (payload.length < 28) throw new KeyRingError('Ciphertext is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  if (additional) decipher.setAAD(additional);
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

export class KeyRing {
  private readonly active = new Map<KeyPurpose, KeyEntry>();
  private readonly entries = new Map<string, KeyEntry>();
  private readonly legacy: Buffer;

  constructor(legacyKeyHex: string, spec?: string) {
    if (!/^[0-9a-f]{64}$/i.test(legacyKeyHex)) throw new KeyRingError('Legacy key must be 32-byte hex');
    this.legacy = Buffer.from(legacyKeyHex, 'hex');
    for (const raw of (spec ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [purpose, keyId, hex, ...rest] = raw.split(':');
      if (rest.length || !purpose || !keyId || !hex) {
        throw new KeyRingError(
          `Invalid key ring entry "${raw.slice(0, 40)}…" (expected purpose:keyId:hex64)`,
        );
      }
      if (!PURPOSES.has(purpose)) throw new KeyRingError(`Unknown key purpose "${purpose}"`);
      if (!KEY_ID_RE.test(keyId) || keyId === LEGACY_KEY_ID) {
        throw new KeyRingError(`Invalid key id "${keyId}" (1–32 chars [A-Za-z0-9_-], not "legacy")`);
      }
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new KeyRingError(`Key ${purpose}:${keyId} must be 32-byte hex`);
      const id = `${purpose}:${keyId}`;
      if (this.entries.has(id)) throw new KeyRingError(`Duplicate key ${id}`);
      const entry: KeyEntry = { purpose: purpose as KeyPurpose, keyId, key: Buffer.from(hex, 'hex') };
      this.entries.set(id, entry);
      if (!this.active.has(entry.purpose)) this.active.set(entry.purpose, entry);
    }
  }

  /** Key id new values of this purpose are sealed with. */
  activeKeyId(purpose: KeyPurpose): string {
    return this.active.get(purpose)?.keyId ?? LEGACY_KEY_ID;
  }

  /** Every key id able to open values of this purpose (active first, legacy last). */
  keyIds(purpose: KeyPurpose): string[] {
    const ids = [...this.entries.values()].filter((e) => e.purpose === purpose).map((e) => e.keyId);
    return [...ids, LEGACY_KEY_ID];
  }

  /** True when a value sealed with `keyId` should be re-encrypted with the active key. */
  needsRotation(purpose: KeyPurpose, keyId: string | null | undefined): boolean {
    return (keyId ?? LEGACY_KEY_ID) !== this.activeKeyId(purpose);
  }

  private keyFor(purpose: KeyPurpose, keyId: string): Buffer {
    if (keyId === LEGACY_KEY_ID) return this.legacy;
    const entry = this.entries.get(`${purpose}:${keyId}`);
    if (!entry) throw new KeyRingError(`Key ${purpose}:${keyId} is not in the key ring`);
    return entry.key;
  }

  // ── strings ────────────────────────────────────────────────────────────────

  sealString(purpose: KeyPurpose, plaintext: string): string {
    const keyId = this.activeKeyId(purpose);
    if (keyId === LEGACY_KEY_ID) {
      // No configured key for this purpose: keep the legacy layout (readable by older builds).
      return seal(this.legacy, Buffer.from(plaintext, 'utf8'), null).toString('base64');
    }
    const payload = seal(this.keyFor(purpose, keyId), Buffer.from(plaintext, 'utf8'), aad(purpose, keyId));
    return `${STRING_PREFIX}.${purpose}.${keyId}.${payload.toString('base64')}`;
  }

  /** Key id of a sealed string ("legacy" for values written before the key ring). */
  keyIdOfString(sealed: string): string {
    return sealed.startsWith(`${STRING_PREFIX}.`) ? (sealed.split('.')[2] ?? LEGACY_KEY_ID) : LEGACY_KEY_ID;
  }

  openString(purpose: KeyPurpose, sealed: string): string {
    if (!sealed.startsWith(`${STRING_PREFIX}.`)) {
      return open(this.legacy, Buffer.from(sealed, 'base64'), null).toString('utf8');
    }
    const [, sealedPurpose, keyId, body] = sealed.split('.');
    if (sealedPurpose !== purpose || !keyId || !body) {
      throw new KeyRingError(`Sealed value belongs to purpose "${sealedPurpose}", expected "${purpose}"`);
    }
    return open(this.keyFor(purpose, keyId), Buffer.from(body, 'base64'), aad(purpose, keyId)).toString(
      'utf8',
    );
  }

  // ── buffers ────────────────────────────────────────────────────────────────

  sealBuffer(purpose: KeyPurpose, plaintext: Buffer): { sealed: Buffer; keyId: string } {
    const keyId = this.activeKeyId(purpose);
    if (keyId === LEGACY_KEY_ID) {
      // No configured key for this purpose: keep the legacy layout (readable by older builds).
      return { sealed: seal(this.legacy, plaintext, null), keyId };
    }
    const id = Buffer.from(keyId, 'ascii');
    const payload = seal(this.keyFor(purpose, keyId), plaintext, aad(purpose, keyId));
    return { sealed: Buffer.concat([BUFFER_MAGIC, Buffer.from([id.length]), id, payload]), keyId };
  }

  /**
   * Opens a sealed buffer. `keyIdHint` is the key id recorded next to the blob (null/"legacy" for
   * blobs written before the key ring, which have no header).
   */
  openBuffer(purpose: KeyPurpose, sealed: Buffer, keyIdHint?: string | null): Buffer {
    const hint = keyIdHint ?? LEGACY_KEY_ID;
    if (hint === LEGACY_KEY_ID) return open(this.legacy, sealed, null);
    if (!sealed.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC)) {
      throw new KeyRingError('Sealed buffer has no key ring header');
    }
    const len = sealed[BUFFER_MAGIC.length]!;
    const start = BUFFER_MAGIC.length + 1;
    const keyId = sealed.subarray(start, start + len).toString('ascii');
    if (keyId !== hint) throw new KeyRingError(`Blob sealed with ${keyId}, expected ${hint}`);
    return open(this.keyFor(purpose, keyId), sealed.subarray(start + len), aad(purpose, keyId));
  }
}

const cache = new WeakMap<object, KeyRing>();

/** The key ring of a validated environment (built once per Env object; throws on a bad spec). */
export function keyRingFor(env: Pick<Env, 'DOCUMENT_ENCRYPTION_KEY' | 'ENCRYPTION_KEYRING'>): KeyRing {
  let ring = cache.get(env);
  if (!ring) {
    ring = new KeyRing(env.DOCUMENT_ENCRYPTION_KEY, env.ENCRYPTION_KEYRING);
    cache.set(env, ring);
  }
  return ring;
}

export function sealString(
  env: Pick<Env, 'DOCUMENT_ENCRYPTION_KEY' | 'ENCRYPTION_KEYRING'>,
  purpose: KeyPurpose,
  plaintext: string,
) {
  return keyRingFor(env).sealString(purpose, plaintext);
}

export function openString(
  env: Pick<Env, 'DOCUMENT_ENCRYPTION_KEY' | 'ENCRYPTION_KEYRING'>,
  purpose: KeyPurpose,
  sealed: string,
) {
  return keyRingFor(env).openString(purpose, sealed);
}
