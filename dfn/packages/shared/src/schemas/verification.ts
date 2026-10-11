import { z } from 'zod';
import { countrySchema } from './common';

export const submitIdentityVerificationSchema = z.object({
  documentType: z.enum(['PASSPORT', 'NATIONAL_ID', 'DRIVER_LICENSE', 'RESIDENCE_PERMIT']),
  issuingCountry: countrySchema,
  /** Document previously uploaded through the documents API (kind IDENTITY). */
  documentId: z.string().uuid().optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /**
   * Sandbox-only hint allowing demos to exercise the failure path.
   * Ignored by any non-sandbox provider.
   */
  sandboxOutcome: z.enum(['PASS', 'FAIL']).optional(),
});
export type SubmitIdentityVerificationInput = z.infer<typeof submitIdentityVerificationSchema>;

export const reviewVerificationSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  notes: z.string().trim().min(3).max(2000),
});
export type ReviewVerificationInput = z.infer<typeof reviewVerificationSchema>;
