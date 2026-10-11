import { z } from 'zod';
import { decimalAmountSchema } from './common';

/**
 * All DDA operations are fictitious research simulations.
 * `currencyCode` is optional and, when present, must be the simulated asset code: the API refuses
 * any operation whose currency is not 'DDA' (no fiat, no other asset).
 */
export const ddaCurrencySchema = z.literal('DDA');

export const ddaMintSchema = z.object({
  organizationId: z.string().uuid(),
  units: decimalAmountSchema,
  /** Simulated USD reserve deposited alongside the mint (hypothesis 1 DDA = 1 USD, never guaranteed). */
  reserveUsd: decimalAmountSchema.optional(),
  note: z.string().trim().max(300).optional(),
  currencyCode: ddaCurrencySchema.optional(),
});
export type DdaMintInput = z.infer<typeof ddaMintSchema>;

export const ddaTransferSchema = z.object({
  fromOrganizationId: z.string().uuid(),
  toOrganizationId: z.string().uuid(),
  units: decimalAmountSchema,
  note: z.string().trim().max(300).optional(),
  currencyCode: ddaCurrencySchema.optional(),
});
export type DdaTransferInput = z.infer<typeof ddaTransferSchema>;

export const ddaRedeemSchema = z.object({
  organizationId: z.string().uuid(),
  units: decimalAmountSchema,
  note: z.string().trim().max(300).optional(),
  currencyCode: ddaCurrencySchema.optional(),
});
export type DdaRedeemInput = z.infer<typeof ddaRedeemSchema>;

export const ddaReserveAdjustmentSchema = z.object({
  deltaUsd: z.string().regex(/^-?\d{1,13}([.,]\d{1,2})?$/),
  note: z.string().trim().min(3).max(300),
});
export type DdaReserveAdjustmentInput = z.infer<typeof ddaReserveAdjustmentSchema>;

export const ddaStressTestSchema = z.object({
  /** Share of supply redeemed in the scenario, 0–100. */
  redemptionPercent: z.number().min(0).max(100).default(30),
  /** Haircut applied to reserve assets in the scenario, 0–100. */
  reserveHaircutPercent: z.number().min(0).max(100).default(0),
});
export type DdaStressTestInput = z.infer<typeof ddaStressTestSchema>;

/** Stable reference format of every simulated DDA operation: DDA-<YYYY>-<XXXXXX>. */
export const ddaReferenceSchema = z.string().regex(/^DDA-\d{4}-[A-Z0-9]{6}$/);
