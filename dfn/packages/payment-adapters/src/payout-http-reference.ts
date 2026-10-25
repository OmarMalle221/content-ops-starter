import {
  PartnerCallError,
  ReferenceHttpClient,
  asObject,
  requireString,
  verifyReferenceWebhook,
  type ReferenceHttpOptions,
  type SignedWebhook,
} from './reference-http';
import {
  assertPayoutRequest,
  parsePayoutCallbackBody,
  parsePayoutStatus,
  type PayoutProvider,
  type PayoutRequest,
  type PayoutResult,
  type PayoutStatusEvent,
} from './payout';

/**
 * HTTP REFERENCE payout provider (generic contract, docs/architecture/PARTNER_ADAPTERS.md).
 *
 * Contract tests only: createPayoutProvider never returns it and no environment variable selects
 * it. Its `mode` is LIVE because that is what such an adapter would be — which is exactly why it
 * stays unreachable while DFN_MODE is sandbox.
 *
 *  POST /v1/payouts        Idempotency-Key = request.idempotencyKey (identical on every retry)
 *  GET  /v1/payouts/{id}
 *  Status callbacks:        X-Reference-Timestamp / X-Reference-Signature (v1=HMAC-SHA256)
 *
 * Amounts travel as integer strings of minor units. The partner must echo the client reference,
 * amount and currency: a mismatch (e.g. an idempotency key colliding with another payout) is
 * refused as BAD_RESPONSE; 409 maps to CONFLICT (key reused with a different payload).
 */

export const REFERENCE_PAYOUT_PROVIDER_CODE = 'reference';

export interface HttpReferencePayoutOptions extends ReferenceHttpOptions {
  callbackSecret: string;
  callbackToleranceSeconds?: number;
  now?: () => Date;
}

export class HttpReferencePayoutProvider implements PayoutProvider {
  readonly code = REFERENCE_PAYOUT_PROVIDER_CODE;
  readonly mode = 'LIVE' as const;
  readonly simulated = false;
  private readonly http: ReferenceHttpClient;
  private readonly now: () => Date;

  constructor(private readonly options: HttpReferencePayoutOptions) {
    if (!options.callbackSecret || options.callbackSecret.length < 16) {
      throw new PartnerCallError('CONFIGURATION', 'Callback secret missing or shorter than 16 characters');
    }
    this.http = new ReferenceHttpClient(options);
    this.now = options.now ?? (() => new Date());
  }

  async createPayout(req: PayoutRequest): Promise<PayoutResult> {
    assertPayoutRequest(req);
    const body = await this.http.post(
      '/v1/payouts',
      {
        clientReference: req.payoutId,
        amount: { minor: req.amountMinor.toString(), currency: req.currencyCode },
        destinationCountry: req.destinationCountry,
        beneficiary: {
          name: req.beneficiary.name,
          method: req.beneficiary.method,
          accountToken: req.beneficiary.accountToken,
        },
        reference: req.reference,
      },
      req.idempotencyKey,
    );
    const result = this.toResult(body);
    if (
      result.payoutId !== req.payoutId ||
      result.amountMinor !== req.amountMinor ||
      result.currencyCode !== req.currencyCode
    ) {
      throw new PartnerCallError('BAD_RESPONSE', 'Partner payout does not match the request');
    }
    return result;
  }

  async getPayout(externalRef: string): Promise<PayoutResult> {
    const result = this.toResult(await this.http.get(`/v1/payouts/${encodeURIComponent(externalRef)}`));
    if (result.externalRef !== externalRef) {
      throw new PartnerCallError('BAD_RESPONSE', 'Partner returned another payout');
    }
    return result;
  }

  parseStatusCallback(callback: SignedWebhook): PayoutStatusEvent {
    verifyReferenceWebhook(this.options.callbackSecret, callback, {
      toleranceSeconds: this.options.callbackToleranceSeconds,
      now: this.now(),
    });
    return parsePayoutCallbackBody(callback.rawBody, this);
  }

  private toResult(value: unknown): PayoutResult {
    const body = asObject(value, 'payout');
    const amount = asObject(body.amount, 'payout amount');
    const minor = amount.minor;
    if (typeof minor !== 'string' || !/^\d{1,30}$/.test(minor)) {
      throw new PartnerCallError('BAD_RESPONSE', 'Payout amount must be an integer string of minor units');
    }
    const createdAt = new Date(requireString(body, 'createdAt', 'payout'));
    if (Number.isNaN(createdAt.getTime())) throw new PartnerCallError('BAD_RESPONSE', 'Invalid createdAt');
    return {
      providerCode: this.code,
      mode: this.mode,
      simulated: false,
      payoutId: requireString(body, 'clientReference', 'payout'),
      externalRef: requireString(body, 'id', 'payout'),
      status: parsePayoutStatus(body.status),
      amountMinor: BigInt(minor),
      currencyCode: requireString(amount, 'currency', 'payout amount'),
      acceptedAt: createdAt,
      ...(typeof body.failureReason === 'string' ? { failureReason: body.failureReason.slice(0, 300) } : {}),
    };
  }
}
