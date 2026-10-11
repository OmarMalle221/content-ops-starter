import { z } from 'zod';
import { CounterpartyLinkStatus } from '../enums';

/**
 * Phase 6 — counterparty link consent.
 *
 * A counterparty (client record) of organisation A can be linked to organisation B (B then sees the
 * invoices / quotes addressed to it and may pay them from its sandbox wallet) only once B accepts.
 * The requester never learns whether the e-mail it typed belongs to a DFN account: until the target
 * decides, "no matching account" (NONE) and "request pending" (PENDING) look identical to it.
 */

/**
 * Link status as shown to the REQUESTING organisation. NONE + PENDING are merged into REQUESTED as
 * soon as a request was attempted, so the response never reveals whether an account matched.
 */
export const CounterpartyLinkPublicStatus = {
  NONE: 'NONE',
  REQUESTED: 'REQUESTED',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  REVOKED: 'REVOKED',
} as const;
export type CounterpartyLinkPublicStatus =
  (typeof CounterpartyLinkPublicStatus)[keyof typeof CounterpartyLinkPublicStatus];

/** Outcome of a link request, identical whether or not an eligible account was found. */
export const CounterpartyLinkRequestOutcome = {
  SENT_IF_ELIGIBLE: 'SENT_IF_ELIGIBLE',
  NOT_REQUESTED: 'NOT_REQUESTED',
} as const;
export type CounterpartyLinkRequestOutcome =
  (typeof CounterpartyLinkRequestOutcome)[keyof typeof CounterpartyLinkRequestOutcome];

/** Maximum link requests an organisation may send over a rolling 24 h window. */
export const COUNTERPARTY_LINK_REQUESTS_PER_DAY = 20;
/** Delay before a link can be requested again after a decline or a revocation. */
export const COUNTERPARTY_LINK_COOLDOWN_HOURS = 24;

/** POST /v1/organizations/:id/counterparties/:counterpartyId/link/request */
export const requestCounterpartyLinkSchema = z.object({
  /**
   * Explicit target: an organisation the caller belongs to (e.g. another workspace of the same
   * person). Without it, the counterparty e-mail is used to find an eligible personal workspace.
   */
  linkedOrganizationId: z.string().uuid().optional(),
});
export type RequestCounterpartyLinkInput = z.infer<typeof requestCounterpartyLinkSchema>;

/** POST /v1/organizations/:id/counterparties/:counterpartyId/link/revoke */
export const revokeCounterpartyLinkSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RevokeCounterpartyLinkInput = z.infer<typeof revokeCounterpartyLinkSchema>;

/** POST /v1/organizations/:id/link-requests/:counterpartyId/(accept|decline) */
export const decideCounterpartyLinkSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type DecideCounterpartyLinkInput = z.infer<typeof decideCounterpartyLinkSchema>;

/** GET /v1/organizations/:id/link-requests — requests addressed to the organisation (target side). */
export const listLinkRequestsQuerySchema = z.object({
  status: z
    .enum([CounterpartyLinkStatus.PENDING, CounterpartyLinkStatus.ACCEPTED, CounterpartyLinkStatus.DECLINED])
    .default(CounterpartyLinkStatus.PENDING),
});
export type ListLinkRequestsQuery = z.infer<typeof listLinkRequestsQuerySchema>;
