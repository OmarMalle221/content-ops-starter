import { z } from 'zod';
import { BeneficiaryMethod, LedgerTransactionKind } from '../enums';
import { countrySchema, currencySchema, decimalAmountSchema, paginationSchema } from './common';

export const createBeneficiarySchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    name: z.string().trim().min(2).max(120),
    country: countrySchema,
    currencyCode: currencySchema,
    method: z.nativeEnum(BeneficiaryMethod),
    /** IBAN / account number / mobile money number — stored encrypted, returned masked. */
    accountIdentifier: z.string().trim().min(6).max(64),
    institutionName: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.method === BeneficiaryMethod.MOBILE_MONEY &&
      !/^\+?\d{8,15}$/.test(v.accountIdentifier.replace(/\s/g, ''))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountIdentifier'],
        message: 'Mobile money identifier must be a phone number',
      });
    }
  });
export type CreateBeneficiaryInput = z.infer<typeof createBeneficiarySchema>;

/** Query parameters of GET /v1/beneficiaries. */
export const listBeneficiariesQuerySchema = z.object({
  organizationId: z.string().uuid().optional(),
  includeRemoved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});
export type ListBeneficiariesQuery = z.infer<typeof listBeneficiariesQuerySchema>;

export const securityPreferencesSchema = z.object({
  requireMfaForTransfers: z.boolean().default(true),
  transferAlerts: z.boolean().default(true),
  /** Optional self-imposed daily limit per currency, decimal string. */
  dailyTransferLimit: decimalAmountSchema.optional().nullable(),
  /**
   * TOTP code, required only when a user who has MFA enabled lowers a protection (turns the
   * transfer step-up off, raises or removes the daily limit). Never stored.
   */
  mfaCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type SecurityPreferencesInput = z.infer<typeof securityPreferencesSchema>;

/** Effective preferences when the user never saved any (User.securityPreferences is null). */
export const DEFAULT_SECURITY_PREFERENCES: Required<Omit<SecurityPreferencesInput, 'mfaCode'>> = {
  requireMfaForTransfers: true,
  transferAlerts: true,
  dailyTransferLimit: null,
};

export const conversionEstimateSchema = z.object({
  sourceCurrency: currencySchema,
  destinationCurrency: currencySchema,
  amount: decimalAmountSchema,
});
export type ConversionEstimateInput = z.infer<typeof conversionEstimateSchema>;

export const sandboxSelfDepositSchema = z.object({
  organizationId: z.string().uuid(),
  currencyCode: currencySchema,
  amount: decimalAmountSchema,
  /** Client-provided idempotency key (scoped to the organisation); the server generates one when absent. */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type SandboxSelfDepositInput = z.infer<typeof sandboxSelfDepositSchema>;

/** Date filter accepted as a plain day (YYYY-MM-DD) or a full ISO timestamp. */
const dateFilterSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Expected YYYY-MM-DD or ISO date-time');

/** Query parameters of GET /v1/wallets/:organizationId/:currency/entries (and statement.csv). */
export const walletEntriesQuerySchema = paginationSchema.extend({
  kind: z.nativeEnum(LedgerTransactionKind).optional(),
  status: z.enum(['POSTED', 'REVERSED']).optional(),
  from: dateFilterSchema.optional(),
  to: dateFilterSchema.optional(),
});
export type WalletEntriesQuery = z.infer<typeof walletEntriesQuerySchema>;

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal('DELETE'),
  reason: z.string().trim().max(500).optional(),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
