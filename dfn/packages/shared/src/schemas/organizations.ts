import { z } from 'zod';
import { OrgRole } from '../enums';
import { countrySchema, emailSchema } from './common';

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  country: countrySchema,
  legalName: z.string().trim().max(200).optional(),
  registrationNumber: z.string().trim().max(60).optional(),
  website: z.string().trim().url().max(200).optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum([OrgRole.ADMIN, OrgRole.MEMBER, OrgRole.VIEWER]).default(OrgRole.MEMBER),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberRoleSchema = z.object({
  role: z.enum([OrgRole.OWNER, OrgRole.ADMIN, OrgRole.MEMBER, OrgRole.VIEWER]),
});

export const submitBusinessVerificationSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  registrationNumber: z.string().trim().min(2).max(60),
  registrationCountry: countrySchema,
  businessType: z.enum(['SOLE_PROPRIETOR', 'COMPANY', 'COOPERATIVE', 'NGO', 'OTHER']),
  registrationDocumentId: z.string().uuid().optional(),
});
export type SubmitBusinessVerificationInput = z.infer<typeof submitBusinessVerificationSchema>;

export const createCounterpartySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema.optional(),
  phone: z.string().trim().max(30).optional(),
  country: countrySchema.optional(),
  notes: z.string().trim().max(1000).optional(),
});
