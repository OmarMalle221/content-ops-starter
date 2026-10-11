import { SetMetadata } from '@nestjs/common';

export const SKIP_IDEMPOTENCY = 'dfn:skipIdempotency';

/**
 * Opts a handler out of the Idempotency-Key replay store. Used by the handlers whose response
 * carries a one-time secret (API key creation / rotation, webhook secret creation / rotation):
 * storing their body would persist the clear secret for IDEMPOTENCY_TTL_HOURS.
 */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true);
