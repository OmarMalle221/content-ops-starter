import { z } from 'zod';
import { TransferStatus } from '../enums';
import { countrySchema, currencySchema, decimalAmountSchema } from './common';
import { mfaProofShape } from './passkeys';

export const createFxQuoteSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    originCountry: countrySchema,
    destinationCountry: countrySchema,
    sourceCurrency: currencySchema,
    destinationCurrency: currencySchema,
    amount: decimalAmountSchema,
  })
  .superRefine((v, ctx) => {
    if (v.originCountry === v.destinationCountry) {
      ctx.addIssue({
        code: 'custom',
        path: ['destinationCountry'],
        message: 'Origin and destination must differ',
      });
    }
  });
export type CreateFxQuoteInput = z.infer<typeof createFxQuoteSchema>;

export const createTransferSchema = z.object({
  quoteId: z.string().uuid(),
  beneficiaryId: z.string().uuid(),
  purpose: z
    .enum(['FAMILY_SUPPORT', 'GOODS', 'SERVICES', 'EDUCATION', 'HEALTH', 'BUSINESS', 'OTHER'])
    .default('OTHER'),
  reference: z.string().trim().max(60).optional(),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const authorizeTransferSchema = z.object({
  /**
   * Fresh MFA proof, required when the user has MFA enabled and requireMfaForTransfers is set:
   * `mfaCode` (TOTP or recovery code) or `passkeyAssertion` (STEP_UP challenge of this session).
   */
  ...mfaProofShape,
});
export type AuthorizeTransferInput = z.infer<typeof authorizeTransferSchema>;

export const cancelTransferSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const listTransfersQuerySchema = z.object({
  organizationId: z.string().uuid().optional(),
  status: z.nativeEnum(TransferStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTransfersQuery = z.infer<typeof listTransfersQuerySchema>;

/** Sandbox partner webhook for transfer processing. */
export const sandboxTransferEventSchema = z.object({
  transferReference: z.string().min(4).max(64),
  outcome: z.enum(['SETTLED', 'FAILED']).default('SETTLED'),
  failureReason: z.string().trim().max(300).optional(),
  externalRef: z.string().max(120).optional(),
});
export type SandboxTransferEventInput = z.infer<typeof sandboxTransferEventSchema>;

export const reviewTransferSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().min(3).max(2000),
});
export type ReviewTransferInput = z.infer<typeof reviewTransferSchema>;

/** Query of GET /v1/transfers/:id/receipt — JSON by default, plain text with ?format=txt. */
export const transferReceiptQuerySchema = z.object({ format: z.enum(['json', 'txt']).default('json') });
export type TransferReceiptQuery = z.infer<typeof transferReceiptQuerySchema>;

/** Admin queue: same filters as the member list, every organisation. */
export const listAdminTransfersQuerySchema = listTransfersQuerySchema;
export type ListAdminTransfersQuery = z.infer<typeof listAdminTransfersQuerySchema>;
