import { z } from 'zod';
import { countrySchema, emailSchema, localeSchema, passwordSchema } from './common';

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  country: countrySchema,
  locale: localeSchema.default('fr'),
  phone: z.string().trim().max(30).optional(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Terms must be accepted' }) }),
  /** Optional transaction invitation token so a seller can register straight from an invite link. */
  invitationToken: z.string().min(16).max(256).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const mfaEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  locale: localeSchema.optional(),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
