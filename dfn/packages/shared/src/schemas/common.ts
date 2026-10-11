import { z } from 'zod';
import { SUPPORTED_COUNTRY_CODES } from '../countries';
import { SUPPORTED_CURRENCY_CODES } from '../money';

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const countrySchema = z
  .string()
  .length(2)
  .toUpperCase()
  .refine((c) => SUPPORTED_COUNTRY_CODES.includes(c), {
    message: 'Unsupported country',
  });
export const currencySchema = z
  .string()
  .length(3)
  .toUpperCase()
  .refine((c) => (SUPPORTED_CURRENCY_CODES as string[]).includes(c), { message: 'Unsupported currency' });

/** Amounts travel over the wire as decimal strings ("1250.00") and are parsed to minor units server-side. */
export const decimalAmountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,13}([.,]\d{1,2})?$/, 'Amount must be a positive decimal with at most 2 decimals');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const localeSchema = z.enum(['fr', 'en']);
export type Locale = z.infer<typeof localeSchema>;

export const passwordSchema = z
  .string()
  .min(12, 'Password must contain at least 12 characters')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), {
    message: 'Password must contain lower case, upper case and digits',
  });
