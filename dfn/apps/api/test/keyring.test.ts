import { describe, expect, it } from 'vitest';
import { KeyPurpose } from '@dfn/shared';
import { decryptBuffer, decryptString, encryptBuffer, encryptString } from '../src/common/crypto';
import { KeyRing, KeyRingError, LEGACY_KEY_ID } from '../src/common/keyring';

const LEGACY = '1'.repeat(64);
const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);

describe('KeyRing', () => {
  it('keeps the legacy layout when no key is configured for a purpose', () => {
    const ring = new KeyRing(LEGACY);
    expect(ring.activeKeyId(KeyPurpose.MFA)).toBe(LEGACY_KEY_ID);
    const sealed = ring.sealString(KeyPurpose.MFA, 'JBSWY3DPEHPK3PXP');
    expect(decryptString(LEGACY, sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(ring.openString(KeyPurpose.MFA, encryptString(LEGACY, 'old'))).toBe('old');
    const { sealed: blob, keyId } = ring.sealBuffer(KeyPurpose.DOCUMENTS, Buffer.from('pdf'));
    expect(keyId).toBe(LEGACY_KEY_ID);
    expect(decryptBuffer(LEGACY, blob).toString()).toBe('pdf');
    expect(
      ring.openBuffer(KeyPurpose.DOCUMENTS, encryptBuffer(LEGACY, Buffer.from('x')), null).toString(),
    ).toBe('x');
  });

  it('seals with the first key of a purpose, opens older keys and legacy values', () => {
    const old = new KeyRing(LEGACY, `mfa:k1:${K1}`);
    const sealedOld = old.sealString(KeyPurpose.MFA, 'secret-1');
    expect(sealedOld.startsWith('k2.mfa.k1.')).toBe(true);
    const rotated = new KeyRing(LEGACY, `mfa:k2:${K2},mfa:k1:${K1}`);
    expect(rotated.activeKeyId(KeyPurpose.MFA)).toBe('k2');
    expect(rotated.keyIds(KeyPurpose.MFA)).toEqual(['k2', 'k1', LEGACY_KEY_ID]);
    expect(rotated.openString(KeyPurpose.MFA, sealedOld)).toBe('secret-1');
    expect(rotated.needsRotation(KeyPurpose.MFA, rotated.keyIdOfString(sealedOld))).toBe(true);
    const fresh = rotated.sealString(KeyPurpose.MFA, 'secret-2');
    expect(rotated.keyIdOfString(fresh)).toBe('k2');
    expect(rotated.needsRotation(KeyPurpose.MFA, 'k2')).toBe(false);
    expect(rotated.openString(KeyPurpose.MFA, encryptString(LEGACY, 'legacy'))).toBe('legacy');
  });

  it('binds the purpose and key id: a value cannot be opened under another purpose', () => {
    const ring = new KeyRing(LEGACY, `mfa:k1:${K1},webhooks:k1:${K1}`);
    const sealed = ring.sealString(KeyPurpose.MFA, 'x');
    expect(() => ring.openString(KeyPurpose.WEBHOOKS, sealed)).toThrow(KeyRingError);
    const forged = sealed.replace('k2.mfa.', 'k2.webhooks.');
    expect(() => ring.openString(KeyPurpose.WEBHOOKS, forged)).toThrow();
  });

  it('seals buffers with a header and checks the recorded key id', () => {
    const ring = new KeyRing(LEGACY, `documents:d1:${K1}`);
    const { sealed, keyId } = ring.sealBuffer(KeyPurpose.DOCUMENTS, Buffer.from('%PDF-1.7'));
    expect(keyId).toBe('d1');
    expect(ring.openBuffer(KeyPurpose.DOCUMENTS, sealed, 'd1').toString()).toBe('%PDF-1.7');
    expect(() => ring.openBuffer(KeyPurpose.DOCUMENTS, sealed, 'd2')).toThrow(KeyRingError);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => ring.openBuffer(KeyPurpose.DOCUMENTS, tampered, 'd1')).toThrow();
  });

  it('rejects malformed key ring specifications', () => {
    expect(() => new KeyRing(LEGACY, 'mfa:k1')).toThrow(KeyRingError);
    expect(() => new KeyRing(LEGACY, `unknown:k1:${K1}`)).toThrow(/purpose/);
    expect(() => new KeyRing(LEGACY, `mfa:legacy:${K1}`)).toThrow(/key id/);
    expect(() => new KeyRing(LEGACY, `mfa:k1:abcd`)).toThrow(/hex/);
    expect(() => new KeyRing(LEGACY, `mfa:k1:${K1},mfa:k1:${K2}`)).toThrow(/Duplicate/);
  });

  it('never echoes key material in configuration errors', () => {
    for (const spec of [`mfa:${K1}`, `${K1}:k1:${K2}`, `mfa:${K1}:${K2}`, `mfa:k1:${K1}:extra`]) {
      let message = '';
      try {
        new KeyRing(LEGACY, spec);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/ENCRYPTION_KEYRING entry #1|must be 32-byte hex/);
      expect(message).not.toMatch(/aaaa|bbbb/);
    }
  });
});
