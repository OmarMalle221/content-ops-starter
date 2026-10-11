import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

/** AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext. */
export function encryptBuffer(keyHex: string, plaintext: Buffer): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptBuffer(keyHex: string, payload: Buffer): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptString(keyHex: string, value: string): string {
  return encryptBuffer(keyHex, Buffer.from(value, 'utf8')).toString('base64');
}

export function decryptString(keyHex: string, value: string): string {
  return decryptBuffer(keyHex, Buffer.from(value, 'base64')).toString('utf8');
}
