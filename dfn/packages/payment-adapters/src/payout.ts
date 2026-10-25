import { createHash, randomBytes } from 'node:crypto';
import type { ProviderMode } from './types';
import {
  PartnerCallError,
  asObject,
  requireString,
  signReferenceWebhook,
  verifyReferenceWebhook,
  type SignedWebhook,
} from './reference-http';

/**
 * Payout partner contract (cash-out to a beneficiary's bank account or mobile-money wallet).
 *
 * Real payouts are always executed by a licensed partner. The sandbox provider below simulates
 * one in memory and NEVER moves money; the HTTP reference provider (./payout-http-reference.ts)
 * exists for contract tests only. Both are reached by explicit construction — the factory
 * createPayoutProvider only ever returns the sandbox provider.
 */

export type PayoutStatus = 'ACCEPTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETURNED';
export const PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'ACCEPTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'RETURNED',
];

export interface PayoutBeneficiary {
  name: string;
  method: 'BANK_ACCOUNT' | 'MOBILE_MONEY';
  /**
   * Opaque token of the destination account issued by the partner's vault (or a platform token).
   * Never a raw account number: the platform keeps those sealed (key ring, BENEFICIARIES).
   */
  accountToken: string;
}

export interface PayoutRequest {
  /** Platform identifier of the payout (e.g. the transfer id). */
  payoutId: string;
  /** Stable per payout attempt; replaying it must return the same payout. */
  idempotencyKey: string;
  amountMinor: bigint;
  currencyCode: string;
  destinationCountry: string;
  beneficiary: PayoutBeneficiary;
  /** Free-text reference shown to the beneficiary. */
  reference: string;
}

export interface PayoutResult {
  providerCode: string;
  mode: ProviderMode;
  simulated: boolean;
  payoutId: string;
  externalRef: string;
  status: PayoutStatus;
  amountMinor: bigint;
  currencyCode: string;
  acceptedAt: Date;
  failureReason?: string;
}

/** Parsed, signature-verified status callback. `idempotencyKey` de-duplicates deliveries. */
export interface PayoutStatusEvent {
  providerCode: string;
  mode: ProviderMode;
  simulated: boolean;
  eventId: string;
  idempotencyKey: string;
  payoutId: string;
  externalRef: string;
  status: PayoutStatus;
  occurredAt: Date;
  failureReason?: string;
}

export interface PayoutProvider {
  readonly code: string;
  readonly mode: ProviderMode;
  readonly simulated: boolean;
  createPayout(req: PayoutRequest): Promise<PayoutResult>;
  getPayout(externalRef: string): Promise<PayoutResult>;
  /** Verifies the HMAC signature and timestamp tolerance of a status callback, then parses it. */
  parseStatusCallback(callback: SignedWebhook): PayoutStatusEvent;
}

/** Validates a payout request before it leaves the platform. */
export function assertPayoutRequest(req: PayoutRequest): void {
  if (typeof req.amountMinor !== 'bigint' || req.amountMinor <= 0n) {
    throw new PartnerCallError('INVALID_REQUEST', 'Payout amount must be a positive bigint (minor units)');
  }
  if (!/^[A-Z]{3}$/.test(req.currencyCode)) throw new PartnerCallError('INVALID_REQUEST', 'Invalid currency');
  if (!/^[A-Z]{2}$/.test(req.destinationCountry)) {
    throw new PartnerCallError('INVALID_REQUEST', 'Invalid destination country');
  }
  if (!req.idempotencyKey || req.idempotencyKey.length < 8 || req.idempotencyKey.length > 200) {
    throw new PartnerCallError('INVALID_REQUEST', 'Idempotency key must be 8–200 characters');
  }
  if (!req.payoutId || !req.beneficiary?.accountToken || !req.beneficiary.name) {
    throw new PartnerCallError('INVALID_REQUEST', 'Payout id and beneficiary are required');
  }
}

/** Fingerprint of the economic content of a request (same key + other content = conflict). */
export function payoutFingerprint(req: PayoutRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        req.payoutId,
        req.amountMinor.toString(),
        req.currencyCode,
        req.destinationCountry,
        req.beneficiary.method,
        req.beneficiary.accountToken,
      ]),
    )
    .digest('hex');
}

export function parsePayoutStatus(value: unknown): PayoutStatus {
  if (typeof value === 'string' && (PAYOUT_STATUSES as readonly string[]).includes(value)) {
    return value as PayoutStatus;
  }
  throw new PartnerCallError('BAD_RESPONSE', `Unknown payout status: ${String(value).slice(0, 40)}`);
}

/** Parses a verified callback body `{eventId, type: 'payout.status', payoutId, externalRef, …}`. */
export function parsePayoutCallbackBody(
  rawBody: string,
  provider: { code: string; mode: ProviderMode; simulated: boolean },
): PayoutStatusEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new PartnerCallError('BAD_RESPONSE', 'Callback body is not valid JSON');
  }
  const body = asObject(parsed, 'callback');
  if (body.type !== 'payout.status') {
    throw new PartnerCallError(
      'BAD_RESPONSE',
      `Unsupported callback type: ${String(body.type).slice(0, 40)}`,
    );
  }
  const occurredAt = new Date(requireString(body, 'occurredAt', 'callback'));
  if (Number.isNaN(occurredAt.getTime())) throw new PartnerCallError('BAD_RESPONSE', 'Invalid occurredAt');
  const eventId = requireString(body, 'eventId', 'callback');
  return {
    providerCode: provider.code,
    mode: provider.mode,
    simulated: provider.simulated,
    eventId,
    idempotencyKey: `${provider.code}:${eventId}`,
    payoutId: requireString(body, 'payoutId', 'callback'),
    externalRef: requireString(body, 'externalRef', 'callback'),
    status: parsePayoutStatus(body.status),
    occurredAt,
    ...(typeof body.failureReason === 'string' ? { failureReason: body.failureReason.slice(0, 300) } : {}),
  };
}

export const SANDBOX_PAYOUT_PROVIDER_CODE = 'SANDBOX_PAYOUT';
const SANDBOX_CALLBACK_SECRET = 'sandbox-payout-callback-secret';

/**
 * Simulated payout partner: in-memory, deterministic external references derived from the
 * idempotency key, idempotent replays, conflicts on key reuse with other content, and signed
 * status callbacks produced by `simulateStatusCallback`. No network, no money.
 */
export class SandboxPayoutProvider implements PayoutProvider {
  readonly code = SANDBOX_PAYOUT_PROVIDER_CODE;
  readonly mode = 'SANDBOX' as const;
  readonly simulated = true;
  private readonly byKey = new Map<string, { fingerprint: string; externalRef: string }>();
  private readonly byRef = new Map<string, PayoutResult>();

  constructor(private readonly options: { callbackSecret?: string; now?: () => Date } = {}) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get secret(): string {
    return this.options.callbackSecret ?? SANDBOX_CALLBACK_SECRET;
  }

  async createPayout(req: PayoutRequest): Promise<PayoutResult> {
    assertPayoutRequest(req);
    const fingerprint = payoutFingerprint(req);
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new PartnerCallError('CONFLICT', 'Idempotency key reused with a different payout', false, 409);
      }
      return { ...this.byRef.get(existing.externalRef)! };
    }
    const externalRef = `sbx_po_${createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 16)}`;
    const result: PayoutResult = {
      providerCode: this.code,
      mode: this.mode,
      simulated: true,
      payoutId: req.payoutId,
      externalRef,
      status: 'ACCEPTED',
      amountMinor: req.amountMinor,
      currencyCode: req.currencyCode,
      acceptedAt: this.now(),
    };
    this.byKey.set(req.idempotencyKey, { fingerprint, externalRef });
    this.byRef.set(externalRef, result);
    return { ...result };
  }

  async getPayout(externalRef: string): Promise<PayoutResult> {
    const found = this.byRef.get(externalRef);
    if (!found) throw new PartnerCallError('NOT_FOUND', 'Unknown sandbox payout', false, 404);
    return { ...found };
  }

  /** Produces a signed status callback (and applies the status) as a partner would. */
  simulateStatusCallback(externalRef: string, status: PayoutStatus, failureReason?: string): SignedWebhook {
    const found = this.byRef.get(externalRef);
    if (!found) throw new PartnerCallError('NOT_FOUND', 'Unknown sandbox payout', false, 404);
    found.status = status;
    if (failureReason) found.failureReason = failureReason;
    const occurredAt = this.now();
    const rawBody = JSON.stringify({
      eventId: `sbx_evt_${randomBytes(8).toString('hex')}`,
      type: 'payout.status',
      payoutId: found.payoutId,
      externalRef,
      status,
      occurredAt: occurredAt.toISOString(),
      simulated: true,
      ...(failureReason ? { failureReason } : {}),
    });
    const timestamp = String(Math.floor(occurredAt.getTime() / 1000));
    return { rawBody, timestamp, signature: signReferenceWebhook(this.secret, timestamp, rawBody) };
  }

  parseStatusCallback(callback: SignedWebhook): PayoutStatusEvent {
    verifyReferenceWebhook(this.secret, callback, { now: this.now() });
    return parsePayoutCallbackBody(callback.rawBody, this);
  }
}
