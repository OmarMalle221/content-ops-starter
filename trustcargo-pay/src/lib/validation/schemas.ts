/**
 * Input validation schemas shared by the wizard (client-side hints) and the server (authoritative).
 * The server always re-validates; client validation is only a UX convenience.
 */
import { z } from 'zod';
import { CURRENCY_CODES } from '@/domain/money';
import { DISPUTE_REASONS, DOCUMENT_TYPES } from '@/domain/model';

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .optional()
        .transform((v) => (v ? v : undefined));
const country = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2');
export const decimalAmount = z
    .string()
    .trim()
    .regex(/^\d{1,13}([.,]\d{1,2})?$/, 'Montant invalide');

export const currencySchema = z.enum(CURRENCY_CODES as [string, ...string[]]);
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);

export const vehicleSchema = z.object({
    make: text(60),
    model: text(60),
    year: z.coerce
        .number()
        .int()
        .min(1980)
        .max(new Date().getFullYear() + 1),
    vin: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'VIN: 17 caractères, sans I, O ni Q'),
    mileageKm: z.coerce.number().int().min(0).max(2_000_000),
    declaredCondition: z.enum(['EXCELLENT', 'GOOD', 'FAIR', 'NEEDS_REPAIR']),
    conditionNotes: optionalText(2000),
    exteriorColor: optionalText(40),
    originCountry: country,
    destinationCountry: country
});

export const milestoneTermSchema = z.object({
    key: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: text(120),
    description: text(1000),
    shareBps: z.coerce.number().int().min(1).max(10_000),
    requiredEvidence: z.array(documentTypeSchema).max(6)
});

export const termsSchema = z.object({
    goodsDescription: text(4000),
    sellerResponsibilities: text(4000),
    buyerResponsibilities: text(4000),
    inspectionTerms: text(4000),
    shippingTerms: text(4000),
    deliveryTerms: text(4000),
    releaseTerms: text(4000),
    refundTerms: text(4000),
    disputeProcedure: text(4000),
    deadlines: z.object({
        inspectionDays: z.coerce.number().int().min(1).max(180),
        shippingDays: z.coerce.number().int().min(1).max(180),
        deliveryDays: z.coerce.number().int().min(1).max(365),
        reviewDays: z.coerce.number().int().min(1).max(60)
    })
});

export const personSchema = z.object({
    fullName: text(120),
    email: z
        .email()
        .max(200)
        .transform((e) => e.toLowerCase()),
    phone: optionalText(30),
    companyName: optionalText(160)
});

export const createVehicleTransactionSchema = z.object({
    vehicle: vehicleSchema,
    price: z.object({ amount: decimalAmount, currency: currencySchema }),
    buyer: personSchema,
    inspector: personSchema.optional(),
    sellerOrganizationId: z.string().uuid().optional(),
    terms: termsSchema,
    milestones: z.array(milestoneTermSchema).min(1).max(10)
});
export type CreateVehicleTransactionInput = z.input<typeof createVehicleTransactionSchema>;

export const amendContractSchema = z.object({
    price: z.object({ amount: decimalAmount, currency: currencySchema }),
    terms: termsSchema,
    milestones: z.array(milestoneTermSchema).min(1).max(10),
    changeSummary: text(1000)
});

export const acceptContractSchema = z.object({
    contractVersionId: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    decision: z.enum(['ACCEPTED', 'DECLINED']),
    comment: optionalText(1000)
});

export const extractedSchema = z.object({
    vin: optionalText(17),
    ownerName: optionalText(160),
    amount: decimalAmount.optional().or(z.literal('').transform(() => undefined)),
    amountCurrency: currencySchema.optional(),
    consignee: optionalText(160),
    shipper: optionalText(160),
    portOfLoading: optionalText(80),
    portOfDischarge: optionalText(80),
    documentNumber: optionalText(80),
    issueDate: optionalText(10)
});

export const uploadDocumentSchema = z.object({
    transactionId: z.string().min(1),
    type: documentTypeSchema,
    title: text(160),
    replacesDocumentId: z.string().optional(),
    milestoneId: z.string().optional(),
    extracted: extractedSchema.prefault({})
});

export const milestoneDecisionSchema = z.object({
    decision: z.enum(['APPROVE', 'REQUEST_CHANGES']),
    reason: optionalText(2000)
});

export const openDisputeSchema = z.object({
    reason: z.enum(DISPUTE_REASONS),
    description: z.string().trim().min(20).max(5000),
    requestedOutcome: text(1000),
    milestoneId: z.string().optional()
});

export const disputeMessageSchema = z.object({
    body: z.string().trim().min(1).max(5000),
    documentIds: z.array(z.string()).max(10).default([])
});

export const disputeDecisionSchema = z.object({
    outcome: z.enum(['RELEASE_TO_SELLER', 'REFUND_TO_BUYER', 'SPLIT', 'RESUME']),
    sellerAmount: decimalAmount.optional(),
    rationale: z.string().trim().min(20).max(5000),
    contractClause: text(200)
});

export const riskReviewSchema = z.object({
    decision: z.enum(['CONFIRMED_RISK', 'RISK_MITIGATED', 'FALSE_POSITIVE', 'NEEDS_INFORMATION', 'ESCALATED']),
    notes: z.string().trim().min(5).max(4000)
});

export const documentReviewSchema = z.object({
    decision: z.enum(['VERIFIED', 'REJECTED', 'NEEDS_INFO']),
    notes: z.string().trim().min(3).max(4000)
});

export const payoutAccountSchema = z.object({
    holderName: text(160),
    bankName: text(120),
    country,
    currency: currencySchema,
    /** Only the last 4 digits are ever sent to TrustCargo; the full number goes to the partner vault. */
    last4: z.string().regex(/^\d{4}$/)
});

export const complianceHoldSchema = z.object({
    type: z.enum(['SANCTIONS_REVIEW', 'COURT_ORDER', 'REGULATORY_FREEZE', 'LAW_ENFORCEMENT_REQUEST']),
    reference: text(120),
    notes: z.string().trim().min(5).max(4000)
});

export const corridorUpdateSchema = z.object({
    enabled: z.boolean(),
    reviewThreshold: decimalAmount,
    reviewThresholdCurrency: currencySchema
});
