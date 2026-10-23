import { z } from 'zod';
import { DocumentKind, TransactionCategory } from '../enums';
import { countrySchema, currencySchema, decimalAmountSchema, emailSchema } from './common';

export const milestoneInputSchema = z.object({
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).optional(),
  amount: decimalAmountSchema,
  requiredEvidence: z.array(z.nativeEnum(DocumentKind)).max(6).default([DocumentKind.PROOF_OF_SHIPMENT]),
});
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;

export const createTransactionSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    title: z.string().trim().min(3).max(140),
    description: z.string().trim().min(10).max(5000),
    category: z.nativeEnum(TransactionCategory).default(TransactionCategory.GOODS),
    currencyCode: currencySchema,
    amount: decimalAmountSchema,
    originCountry: countrySchema,
    destinationCountry: countrySchema,
    seller: z.object({
      email: emailSchema,
      name: z.string().trim().min(1).max(120).optional(),
    }),
    milestones: z.array(milestoneInputSchema).min(1).max(12),
    /** Payment conditions captured in the digital contract. */
    terms: z
      .object({
        deliveryDeadlineDays: z.number().int().min(1).max(365).default(60),
        inspectionWindowDays: z.number().int().min(0).max(30).default(5),
        governingLaw: z.string().trim().max(120).default('Canada (Québec)'),
        additionalClauses: z.string().trim().max(5000).optional(),
      })
      // prefault: an omitted `terms` is parsed as {} so that each field gets its own default.
      .prefault({}),
    /** Optional sandbox-only shortcut used by demos & e2e tests. */
    sendInvitation: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.originCountry === value.destinationCountry) {
      ctx.addIssue({
        code: 'custom',
        message: 'Origin and destination must differ',
        path: ['destinationCountry'],
      });
    }
  });
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const listTransactionsQuerySchema = z.object({
  status: z.string().optional(),
  role: z.enum(['BUYER', 'SELLER']).optional(),
  organizationId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(16).max(256),
  organizationId: z.string().uuid().optional(),
});

export const acceptTermsSchema = z.object({
  contractVersionId: z.string().uuid(),
  accept: z.literal(true),
});

export const cancelTransactionSchema = z.object({ reason: z.string().trim().min(3).max(1000) });

export const submitMilestoneSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  documentIds: z.array(z.string().uuid()).min(1).max(10),
});
export type SubmitMilestoneInput = z.infer<typeof submitMilestoneSchema>;

export const approveMilestoneSchema = z.object({ note: z.string().trim().max(2000).optional() });

export const requestChangesSchema = z.object({ note: z.string().trim().min(3).max(2000) });

export const requestRefundSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

export const fundingRequestSchema = z.object({
  method: z.enum(['BANK_TRANSFER_SIMULATED', 'WALLET_SIMULATED']).default('BANK_TRANSFER_SIMULATED'),
});
export type FundingRequestInput = z.infer<typeof fundingRequestSchema>;

/** Sandbox partner webhook payload — simulates the licensed partner confirming receipt. */
export const sandboxFundingConfirmationSchema = z.object({
  fundingReference: z.string().min(4).max(64),
  outcome: z.enum(['CONFIRMED', 'FAILED']).default('CONFIRMED'),
  externalRef: z.string().max(120).optional(),
});
export type SandboxFundingConfirmationInput = z.infer<typeof sandboxFundingConfirmationSchema>;

export const documentMetadataSchema = z.object({
  kind: z.nativeEnum(DocumentKind).default(DocumentKind.OTHER),
  title: z.string().trim().min(1).max(140).optional(),
  transactionId: z.string().uuid().optional(),
  organizationId: z.string().uuid().optional(),
});
export type DocumentMetadataInput = z.infer<typeof documentMetadataSchema>;

export const reviewDocumentSchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  note: z.string().trim().max(1000).optional(),
});
