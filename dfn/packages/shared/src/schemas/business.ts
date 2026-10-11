import { z } from 'zod';
import { InvoicePaymentMethod } from '../enums';
import { currencySchema, decimalAmountSchema, emailSchema } from './common';

export const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(100000).default(1),
  unitPrice: decimalAmountSchema,
});
export type LineItemInput = z.infer<typeof lineItemSchema>;

const documentBase = {
  /** Issuing organisation; defaults to the caller's personal workspace (see resolveActingOrganization). */
  organizationId: z.string().uuid().optional(),
  counterpartyId: z.string().uuid().optional(),
  customerName: z.string().trim().min(1).max(160),
  customerEmail: emailSchema.optional(),
  currencyCode: currencySchema,
  lines: z.array(lineItemSchema).min(1).max(50),
  /** Tax expressed in basis points of the subtotal (e.g. 1800 = 18 % TVA). */
  taxBps: z.number().int().min(0).max(5000).default(0),
  notes: z.string().trim().max(2000).optional(),
};

export const createInvoiceSchema = z.object({
  ...documentBase,
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  transactionId: z.string().uuid().optional(),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = createInvoiceSchema.partial();

export const recordInvoicePaymentSchema = z.object({
  amount: decimalAmountSchema,
  method: z.nativeEnum(InvoicePaymentMethod).default(InvoicePaymentMethod.EXTERNAL_RECORDED),
  reference: z.string().trim().max(120).optional(),
  paidAt: z.string().datetime().optional(),
  /** WALLET_SIMULATED only: the paying organisation (must be the counterparty's linked organisation). */
  organizationId: z.string().uuid().optional(),
});
export type RecordInvoicePaymentInput = z.infer<typeof recordInvoicePaymentSchema>;

/** Cancelling an invoice or declining a quote may carry a short reason. */
export const cancelDocumentSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type CancelDocumentInput = z.infer<typeof cancelDocumentSchema>;

/** Accepting / declining a quote is recorded by the issuer on behalf of the customer. */
export const quoteDecisionSchema = z.object({ note: z.string().trim().max(500).optional() });
export type QuoteDecisionInput = z.infer<typeof quoteDecisionSchema>;

export const createQuoteSchema = z.object({
  ...documentBase,
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const updateQuoteSchema = createQuoteSchema.partial();

export const convertQuoteSchema = z.object({
  target: z.enum(['INVOICE', 'PROTECT_TRANSACTION']),
  /** Required for PROTECT_TRANSACTION: seller is the organisation, buyer is the customer email. */
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  originCountry: z.string().length(2).toUpperCase().optional(),
  destinationCountry: z.string().length(2).toUpperCase().optional(),
});
export type ConvertQuoteInput = z.infer<typeof convertQuoteSchema>;

export const reportQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  currencyCode: currencySchema.optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const listDocumentsQuerySchema = z.object({
  status: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

/**
 * Organisation-scoped listing. ISSUED = documents issued by the organisation (default);
 * RECEIVED = invoices addressed to a counterparty linked to the organisation (customer view).
 */
export const listBusinessDocumentsQuerySchema = listDocumentsQuerySchema.extend({
  organizationId: z.string().uuid().optional(),
  scope: z.enum(['ISSUED', 'RECEIVED']).default('ISSUED'),
});
export type ListBusinessDocumentsQuery = z.infer<typeof listBusinessDocumentsQuerySchema>;

export const businessOrganizationQuerySchema = z.object({ organizationId: z.string().uuid() });
export type BusinessOrganizationQuery = z.infer<typeof businessOrganizationQuerySchema>;
