import { z } from 'zod';
import { BeneficiaryMethod } from '../enums';
import { countrySchema, currencySchema, decimalAmountSchema } from './common';

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

export const securityPreferencesSchema = z.object({
  requireMfaForTransfers: z.boolean().default(true),
  transferAlerts: z.boolean().default(true),
  /** Optional self-imposed daily limit per currency, decimal string. */
  dailyTransferLimit: decimalAmountSchema.optional().nullable(),
});
export type SecurityPreferencesInput = z.infer<typeof securityPreferencesSchema>;

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
});
export type SandboxSelfDepositInput = z.infer<typeof sandboxSelfDepositSchema>;

export const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
  confirmation: z.literal('DELETE'),
  reason: z.string().trim().max(500).optional(),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
