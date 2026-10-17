import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KeyPurpose } from '@dfn/shared';
import type { Env } from '../config/env';

/**
 * Key ring — one AES-256-GCM key per purpose (documents, MFA secrets, webhook secrets,
 * beneficiary identifiers), several versions per purpose to allow rotation.
 *
 * Two layers of keys (ADR-0010, ADR-0014):
 *  - environment keys (ENCRYPTION_KEYRING): the first entry of a purpose is its active key;
 *  - KMS-managed data keys (EncryptionKey rows, unwrapped by the KMS and installed with
 *    `setManagedKeys`): an ACTIVE managed key overrides the environment's active key for its
 *    purpose; STAGED and DECRYPT_ONLY managed keys only open values. Their ids carry the reserved
 *    prefix "kms-", which ENCRYPTION_KEYRING may not use, so the two layers never collide.
 *
 * Formats (the purpose and key id are bound as GCM additional data, so a ciphertext cannot be
 * replayed under another purpose or key):
 *  - sealed string: `k2.<purpose>.<keyId>.<base64(iv | tag | ciphertext)>`
 *  - sealed buffer: `DFNK2` | keyIdLength (1 byte) | keyId | iv(12) | tag(16) | ciphertext
 * Legacy values (phases 0–5) carry no header: they were sealed with DOCUMENT_ENCRYPTION_KEY
 * (`iv | tag | ciphertext`, strings in base64) and remain readable under the key id "legacy" —
 * until ENCRYPTION_LEGACY_DECRYPT=false retires that key (the ring then refuses them).
 */
export const LEGACY_KEY_ID = 'legacy';
/** Key ids of KMS-managed data keys start with this prefix (refused in ENCRYPTION_KEYRING). */
export const MANAGED_KEY_PREFIX = 'kms-';
const STRING_PREFIX = 'k2';
const BUFFER_MAGIC = Buffer.from('DFNK2', 'ascii');
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PURPOSES = new Set<string>(Object.values(KeyPurpose));

/** A syntactically valid key id carrying the managed-key prefix. */
export function isManagedKeyId(keyId: string): boolean {
  return KEY_ID_RE.test(keyId) && keyId.startsWith(MANAGED_KEY_PREFIX);
}

interface KeyEntry {
  purpose: KeyPurpose;
  keyId: string;
  key: Buffer;
}

export class KeyRingError extends Error {}

/** A KMS-managed data key, already unwrapped, as installed in the ring. */
export interface ManagedKeyMaterial {
  purpose: KeyPurpose;
  keyId: string;
  /** 32-byte data key. The ring keeps a reference: the caller must not reuse the buffer. */
  key: Buffer;
  /** ACTIVE: seals new values of its purpose. STAGED / DECRYPT_ONLY: only opens values. */
  active: boolean;
}

export interface KeyRingOptions {
  /**
   * false (ENCRYPTION_LEGACY_DECRYPT=false): the legacy DOCUMENT_ENCRYPTION_KEY is retired —
   * legacy-layout values are refused and nothing is sealed with it any more.
   */
  legacyDecrypt?: boolean;
}

const LEGACY_DISABLED = 'Legacy decryption is disabled (ENCRYPTION_LEGACY_DECRYPT=false)';

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
  /** Environment layer (ENCRYPTION_KEYRING), fixed for the life of the ring. */
  private readonly active = new Map<KeyPurpose, KeyEntry>();
  private readonly entries = new Map<string, KeyEntry>();
  /** Managed layer, replaced as a whole by setManagedKeys (never mutated in place). */
  private managed = new Map<string, KeyEntry>();
  private managedActive = new Map<KeyPurpose, KeyEntry>();
  private readonly legacy: Buffer;
  /** False once the legacy key is retired (ENCRYPTION_LEGACY_DECRYPT=false). */
  readonly legacyDecrypt: boolean;

  constructor(legacyKeyHex: string, spec?: string, options: KeyRingOptions = {}) {
    if (!/^[0-9a-f]{64}$/i.test(legacyKeyHex)) throw new KeyRingError('Legacy key must be 32-byte hex');
    this.legacy = Buffer.from(legacyKeyHex, 'hex');
    this.legacyDecrypt = options.legacyDecrypt ?? true;
    const entries = (spec ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const [index, raw] of entries.entries()) {
      // Error messages never echo the raw entry: a malformed entry may contain key material.
      const where = `ENCRYPTION_KEYRING entry #${index + 1}`;
      const [purpose, keyId, hex, ...rest] = raw.split(':');
      if (rest.length || !purpose || !keyId || !hex) {
        throw new KeyRingError(`${where} is invalid (expected purpose:keyId:hex64)`);
      }
      if (!PURPOSES.has(purpose)) {
        throw new KeyRingError(`${where} has an unknown purpose (expected ${[...PURPOSES].join(', ')})`);
      }
      if (!KEY_ID_RE.test(keyId) || keyId === LEGACY_KEY_ID) {
        throw new KeyRingError(
          `${where} (${purpose}) has an invalid key id (1–32 chars [A-Za-z0-9_-], not "legacy")`,
        );
      }
      if (keyId.startsWith(MANAGED_KEY_PREFIX)) {
        throw new KeyRingError(
          `${where} (${purpose}) uses the key id prefix "${MANAGED_KEY_PREFIX}", reserved for KMS-managed keys`,
        );
      }
      if (!/^[0-9a-f]{64}$/i.test(hex)) throw new KeyRingError(`Key ${purpose}:${keyId} must be 32-byte hex`);
      const id = `${purpose}:${keyId}`;
      if (this.entries.has(id)) throw new KeyRingError(`Duplicate key ${id}`);
      const entry: KeyEntry = { purpose: purpose as KeyPurpose, keyId, key: Buffer.from(hex, 'hex') };
      this.entries.set(id, entry);
      if (!this.active.has(entry.purpose)) this.active.set(entry.purpose, entry);
    }
  }

  /**
   * Replaces the managed layer with `keys` (atomically: the ring keeps its previous managed keys
   * when the set is invalid). At most one active key per purpose; ids must carry the "kms-" prefix.
   */
  setManagedKeys(keys: readonly ManagedKeyMaterial[]): void {
    const managed = new Map<string, KeyEntry>();
    const managedActive = new Map<KeyPurpose, KeyEntry>();
    for (const k of keys) {
      if (!PURPOSES.has(k.purpose)) throw new KeyRingError('Managed key has an unknown purpose');
      if (!isManagedKeyId(k.keyId))
        throw new KeyRingError(`Managed key id of purpose ${k.purpose} is invalid`);
      if (k.key.length !== 32) throw new KeyRingError(`Managed key ${k.purpose}:${k.keyId} is not 32 bytes`);
      const id = `${k.purpose}:${k.keyId}`;
      if (managed.has(id) || this.entries.has(id)) throw new KeyRingError(`Duplicate key ${id}`);
      const entry: KeyEntry = { purpose: k.purpose, keyId: k.keyId, key: k.key };
      managed.set(id, entry);
      if (k.active) {
        if (managedActive.has(k.purpose)) {
          throw new KeyRingError(`Two active managed keys for purpose ${k.purpose}`);
        }
        managedActive.set(k.purpose, entry);
      }
    }
    this.managed = managed;
    this.managedActive = managedActive;
  }

  /** Ids of the managed keys installed for this purpose. */
  managedKeyIds(purpose: KeyPurpose): string[] {
    return [...this.managed.values()].filter((e) => e.purpose === purpose).map((e) => e.keyId);
  }

  /** Key id new values of this purpose are sealed with ("legacy" when no key is configured). */
  activeKeyId(purpose: KeyPurpose): string {
    return (this.managedActive.get(purpose) ?? this.active.get(purpose))?.keyId ?? LEGACY_KEY_ID;
  }

  /**
   * Every key id able to open values of this purpose: the active key first, then the
   * environment keys, then the other managed keys (newest id first), "legacy" last unless retired.
   */
  keyIds(purpose: KeyPurpose): string[] {
    const active = this.activeKeyId(purpose);
    const env = [...this.entries.values()].filter((e) => e.purpose === purpose).map((e) => e.keyId);
    const managed = this.managedKeyIds(purpose).sort().reverse();
    const ids = [...env, ...managed].filter((id) => id !== active);
    return [
      ...(active === LEGACY_KEY_ID ? [] : [active]),
      ...ids,
      ...(this.legacyDecrypt ? [LEGACY_KEY_ID] : []),
    ];
  }

  /** True when a value sealed with `keyId` should be re-encrypted with the active key. */
  needsRotation(purpose: KeyPurpose, keyId: string | null | undefined): boolean {
    return (keyId ?? LEGACY_KEY_ID) !== this.activeKeyId(purpose);
  }

  private entryFor(purpose: KeyPurpose, keyId: string): KeyEntry | undefined {
    const id = `${purpose}:${keyId}`;
    return this.managed.get(id) ?? this.entries.get(id);
  }

  private keyFor(purpose: KeyPurpose, keyId: string): Buffer {
    if (keyId === LEGACY_KEY_ID) {
      if (!this.legacyDecrypt) throw new KeyRingError(LEGACY_DISABLED);
      return this.legacy;
    }
    const entry = this.entryFor(purpose, keyId);
    if (!entry) throw new KeyRingError(`Key ${purpose}:${keyId} is not in the key ring`);
    return entry.key;
  }

  /** Key used to seal new values: refuses the legacy fallback once the legacy key is retired. */
  private sealingKeyId(purpose: KeyPurpose): string {
    const keyId = this.activeKeyId(purpose);
    if (keyId === LEGACY_KEY_ID && !this.legacyDecrypt) {
      throw new KeyRingError(`No active key for purpose "${purpose}" and the legacy key is retired`);
    }
    return keyId;
  }

  // ── strings ────────────────────────────────────────────────────────────────

  sealString(purpose: KeyPurpose, plaintext: string): string {
    const keyId = this.sealingKeyId(purpose);
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
      return open(this.keyFor(purpose, LEGACY_KEY_ID), Buffer.from(sealed, 'base64'), null).toString('utf8');
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
    const keyId = this.sealingKeyId(purpose);
    if (keyId === LEGACY_KEY_ID) {
      // No configured key for this purpose: keep the legacy layout (readable by older builds).
      return { sealed: seal(this.legacy, plaintext, null), keyId };
    }
    const id = Buffer.from(keyId, 'ascii');
    const payload = seal(this.keyFor(purpose, keyId), plaintext, aad(purpose, keyId));
    return { sealed: Buffer.concat([BUFFER_MAGIC, Buffer.from([id.length]), id, payload]), keyId };
  }

  /**
   * Key id named in a sealed buffer's header ("legacy" when the buffer has no key ring header).
   * The header is not authenticated on its own: it only selects the key to try, and the GCM tag
   * (with the purpose and key id bound as additional data) is what proves the blob is genuine.
   */
  keyIdOfBuffer(sealed: Buffer): string {
    if (!sealed.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC)) return LEGACY_KEY_ID;
    const len = sealed[BUFFER_MAGIC.length] ?? 0;
    const start = BUFFER_MAGIC.length + 1;
    const keyId = sealed.subarray(start, start + len).toString('ascii');
    return KEY_ID_RE.test(keyId) ? keyId : LEGACY_KEY_ID;
  }

  /** True when `keyId` (or "legacy") can open values of this purpose with the current ring. */
  hasKey(purpose: KeyPurpose, keyId: string | null | undefined): boolean {
    const id = keyId ?? LEGACY_KEY_ID;
    return id === LEGACY_KEY_ID ? this.legacyDecrypt : this.entryFor(purpose, id) !== undefined;
  }

  /**
   * Opens a sealed buffer. `keyIdHint` is the key id recorded next to the blob (null/"legacy" for
   * blobs written before the key ring, which have no header).
   */
  openBuffer(purpose: KeyPurpose, sealed: Buffer, keyIdHint?: string | null): Buffer {
    const hint = keyIdHint ?? LEGACY_KEY_ID;
    if (hint === LEGACY_KEY_ID) return open(this.keyFor(purpose, LEGACY_KEY_ID), sealed, null);
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

/** Environment fields the key ring is built from (ENCRYPTION_LEGACY_DECRYPT defaults to true). */
export type KeyRingEnv = Pick<Env, 'DOCUMENT_ENCRYPTION_KEY' | 'ENCRYPTION_KEYRING'> &
  Partial<Pick<Env, 'ENCRYPTION_LEGACY_DECRYPT'>>;

/**
 * The key ring of a validated environment (built once per Env object; throws on a bad spec). The
 * managed layer of that same instance is kept up to date by ManagedKeysService, so every caller
 * holding the Env sees KMS-managed keys without knowing about them.
 */
export function keyRingFor(env: KeyRingEnv): KeyRing {
  let ring = cache.get(env);
  if (!ring) {
    ring = new KeyRing(env.DOCUMENT_ENCRYPTION_KEY, env.ENCRYPTION_KEYRING, {
      legacyDecrypt: env.ENCRYPTION_LEGACY_DECRYPT ?? true,
    });
    cache.set(env, ring);
  }
  return ring;
}

export function sealString(env: KeyRingEnv, purpose: KeyPurpose, plaintext: string) {
  return keyRingFor(env).sealString(purpose, plaintext);
}

export function openString(env: KeyRingEnv, purpose: KeyPurpose, sealed: string) {
  return keyRingFor(env).openString(purpose, sealed);
}
