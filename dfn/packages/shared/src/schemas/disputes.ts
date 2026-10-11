import { z } from 'zod';
import { DisputeOutcome, DisputeReason } from '../enums';
import { decimalAmountSchema } from './common';

export const openDisputeSchema = z.object({
  reason: z.nativeEnum(DisputeReason),
  description: z.string().trim().min(20).max(5000),
  documentIds: z.array(z.string().uuid()).max(10).default([]),
});
export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;

export const disputeMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  documentId: z.string().uuid().optional(),
  /** Staff-only: internal notes never shown to parties. */
  internal: z.boolean().default(false),
});
export type DisputeMessageInput = z.infer<typeof disputeMessageSchema>;

export const disputeDecisionSchema = z
  .object({
    outcome: z.nativeEnum(DisputeOutcome),
    rationale: z.string().trim().min(20).max(5000),
    sellerAmount: decimalAmountSchema.optional(),
    buyerAmount: decimalAmountSchema.optional(),
    isFinal: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === DisputeOutcome.SPLIT && (!v.sellerAmount || !v.buyerAmount)) {
      ctx.addIssue({
        code: 'custom',
        message: 'SPLIT requires sellerAmount and buyerAmount',
        path: ['outcome'],
      });
    }
  });
export type DisputeDecisionInput = z.infer<typeof disputeDecisionSchema>;

export const appealDisputeSchema = z.object({ grounds: z.string().trim().min(20).max(5000) });
