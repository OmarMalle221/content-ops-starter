import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { authenticator as totp } from 'otplib';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import { Client, PASSWORD, type TestContext } from './app';

/** Defaults of the API env (WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS) used by the test app. */
export const TEST_RP_ID = 'localhost';
export const TEST_ORIGIN = 'http://localhost:3000';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (bytes: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(bytes));

function u32be(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  /** Answer another challenge than the one in the options. */
  challenge?: string;
  /** Clear the user-verified flag. */
  noUserVerification?: boolean;
}

/**
 * Minimal software WebAuthn authenticator (EC P-256 / ES256, "none" attestation) for API tests:
 * builds authenticatorData (rpIdHash, UP+UV(+AT) flags, signature counter, attested credential
 * data with a COSE key), the CBOR attestationObject, clientDataJSON bound to the server challenge
 * and origin, and ES256 signatures over authenticatorData || SHA-256(clientDataJSON).
 */
export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  /** Base64url user handle received at registration (returned in assertions). */
  userHandle?: string;

  constructor(
    public counter = 0,
    private readonly counterStep = 1,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    const y = Buffer.from(jwk.y!, 'base64url');
    this.cosePublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(x)],
        [-3, new Uint8Array(y)],
      ]),
    );
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private authenticatorData(rpId: string, counter: number, attested: boolean, uv: boolean): Buffer {
    const rpIdHash = createHash('sha256').update(rpId).digest();
    const flags = FLAG_UP | (uv ? FLAG_UV : 0) | (attested ? FLAG_AT : 0);
    const parts: Buffer[] = [rpIdHash, Buffer.from([flags]), u32be(counter)];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, Buffer.from(this.cosePublicKey));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  /** navigator.credentials.create() equivalent: RegistrationResponseJSON for the given options. */
  createCredential(options: any, overrides: CeremonyOverrides = {}) {
    this.userHandle = options.user?.id;
    const authData = this.authenticatorData(
      overrides.rpId ?? options.rp?.id ?? TEST_RP_ID,
      this.counter,
      true,
      !overrides.noUserVerification,
    );
    const attStmt = new Map<string, string>();
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', attStmt],
        ['authData', new Uint8Array(authData)],
      ]),
    );
    const clientDataJSON = this.clientData(
      'webauthn.create',
      overrides.challenge ?? options.challenge,
      overrides.origin ?? TEST_ORIGIN,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
    };
  }

  /**
   * navigator.credentials.get() equivalent: AuthenticationResponseJSON. The signature counter
   * advances by `counterStep` unless `counter` forces a value (e.g. a regression).
   */
  getAssertion(options: any, overrides: CeremonyOverrides & { counter?: number } = {}) {
    if (overrides.counter !== undefined) this.counter = overrides.counter;
    else this.counter += this.counterStep;
    const authData = this.authenticatorData(
      overrides.rpId ?? options.rpId ?? TEST_RP_ID,
      this.counter,
      false,
      !overrides.noUserVerification,
    );
    const clientDataJSON = this.clientData(
      'webauthn.get',
      overrides.challenge ?? options.challenge,
      overrides.origin ?? TEST_ORIGIN,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      authenticatorAttachment: 'platform' as const,
      clientExtensionResults: {},
    };
  }
}

/**
 * Registers a passkey for a signed-in client; returns the API response of the verify step. The
 * fresh proof defaults to the current password (accounts without MFA).
 */
export async function registerPasskey(
  client: Client,
  device: SoftwareAuthenticator,
  name = 'Clé de test',
  proof: Record<string, unknown> = { currentPassword: PASSWORD },
) {
  const options = await client.post('/v1/auth/passkeys/registration/options', proof);
  if (options.status !== 200) throw new Error(`options ${options.status} ${JSON.stringify(options.body)}`);
  return client.post('/v1/auth/passkeys/registration/verify', {
    name,
    response: device.createCredential(options.body),
  });
}

/** Passwordless login from a fresh (cookie-less) client. */
export async function passkeyLogin(ctx: TestContext, device: SoftwareAuthenticator, overrides = {}) {
  const client = new Client(ctx);
  const options = await client.post('/v1/auth/passkeys/authentication/options', {});
  const res = await client.post('/v1/auth/passkeys/authentication/verify', {
    response: device.getAssertion(options.body, overrides),
  });
  return { client, res, options: options.body };
}

/** A passkey assertion answering a STEP_UP challenge of this client's session. */
export async function stepUpAssertion(client: Client, device: SoftwareAuthenticator, overrides = {}) {
  const options = await client.post('/v1/auth/passkeys/step-up/options');
  if (options.status !== 200) throw new Error(`step-up ${options.status} ${JSON.stringify(options.body)}`);
  return device.getAssertion(options.body, overrides);
}

/** DELETE with a JSON body (the shared Client sends DELETE without body). */
export function deleteWithBody(ctx: TestContext, client: Client, url: string, body?: unknown) {
  const cookie = (client as unknown as { cookie: string }).cookie;
  let r = ctx.http().delete(url);
  if (cookie) r = r.set('Cookie', cookie);
  return r.send(body ?? {});
}

/** TOTP time step burnt by the most recent enrolment (the confirmation code is single-use). */
let lastEnrolmentStep = -1;
const currentTotpStep = () => Math.floor(Date.now() / 30_000);

/**
 * Enables TOTP MFA for a signed-in client (code + current password); returns the secret and the
 * one-time recovery codes. The confirmation code is burnt: `waitForFreshTotpStep` then skips
 * that step so the next generated code is usable.
 */
export async function enableMfa(client: Client, password = PASSWORD) {
  const setup = await client.post('/v1/auth/mfa/setup');
  if (setup.status !== 201) throw new Error(`mfa setup ${setup.status}`);
  const secret = setup.body.secret as string;
  await waitForStepTime(3);
  const step = currentTotpStep();
  const enabled = await client.post('/v1/auth/mfa/enable', {
    code: totp.generate(secret),
    currentPassword: password,
  });
  if (enabled.status !== 201) throw new Error(`mfa enable ${enabled.status} ${JSON.stringify(enabled.body)}`);
  lastEnrolmentStep = step;
  return { secret, recoveryCodes: enabled.body.recoveryCodes as string[] };
}

/**
 * Waits for the next 30-second TOTP step when fewer than `minSeconds` remain in the current one,
 * so a test that uses a code twice is not split across a step boundary. Also skips the step burnt
 * by the last `enableMfa` (its code was consumed by the enrolment).
 */
export async function waitForFreshTotpStep(minSeconds = 6) {
  if (currentTotpStep() <= lastEnrolmentStep) await sleep(totp.timeRemaining() * 1000 + 250);
  await waitForStepTime(minSeconds);
}

/** Waits for the next step when fewer than `minSeconds` remain in the current one. */
async function waitForStepTime(minSeconds: number) {
  const remaining = totp.timeRemaining();
  if (remaining < minSeconds) await sleep(remaining * 1000 + 250);
}

/** Waits until the TOTP step changes (a new, never used code becomes available). */
export async function waitForNextTotpStep() {
  await sleep(totp.timeRemaining() * 1000 + 250);
}
