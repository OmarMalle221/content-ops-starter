import { HttpStatus } from '@nestjs/common';
import { Prisma, type PrismaTransactionClient } from '@dfn/database';
import { ErrorCode, parseDecimalToMinor, type LineItemInput } from '@dfn/shared';
import { DomainError } from '../../common/domain-error';

/** Every business document carries the sandbox disclaimer (French canonical wording). */
export const BUSINESS_DISCLAIMER_FR = 'Données fictives — Aucun fonds réel';

export interface ComputedLine {
  position: number;
  description: string;
  quantity: number;
  unitPriceMinor: bigint;
  totalMinor: bigint;
}

export interface DocumentTotals {
  lines: ComputedLine[];
  subtotalMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

/** Tax in basis points of the subtotal, rounded half-up, integer arithmetic only. */
export function computeTaxMinor(subtotalMinor: bigint, taxBps: number): bigint {
  if (!Number.isInteger(taxBps) || taxBps < 0)
    throw DomainError.validation('taxBps must be a non-negative integer');
  return (subtotalMinor * BigInt(taxBps) + 5_000n) / 10_000n;
}

/**
 * line total = quantity × unit price (minor units); subtotal = Σ line totals;
 * tax = subtotal × taxBps / 10 000 (half-up); total = subtotal + tax.
 */
export function computeDocumentTotals(
  lines: LineItemInput[],
  taxBps: number,
  currencyCode: string,
): DocumentTotals {
  const computed: ComputedLine[] = lines.map((line, index) => {
    let unitPriceMinor: bigint;
    try {
      unitPriceMinor = parseDecimalToMinor(line.unitPrice, currencyCode);
    } catch (err) {
      throw DomainError.validation(err instanceof Error ? err.message : 'Invalid unit price', {
        path: `lines.${index}.unitPrice`,
      });
    }
    const quantity = line.quantity ?? 1;
    return {
      position: index + 1,
      description: line.description,
      quantity,
      unitPriceMinor,
      totalMinor: unitPriceMinor * BigInt(quantity),
    };
  });
  const subtotalMinor = computed.reduce((acc, l) => acc + l.totalMinor, 0n);
  if (subtotalMinor <= 0n) throw DomainError.validation('The document total must be greater than zero');
  const taxMinor = computeTaxMinor(subtotalMinor, taxBps);
  return { lines: computed, subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor };
}

/**
 * Best-effort inverse of computeTaxMinor. LEGACY READ FALLBACK ONLY: documents created before the
 * rate was persisted (taxBps = 0 while taxMinor > 0). Deriving from rounded amounts is lossy (e.g.
 * 1333 bps on a small subtotal reads back as 1300), so it must never drive a write by itself.
 */
export function deriveTaxBps(subtotalMinor: bigint, taxMinor: bigint): number {
  if (subtotalMinor <= 0n) return 0;
  return Number((taxMinor * 10_000n + subtotalMinor / 2n) / subtotalMinor);
}

/** The persisted tax rate of an invoice / quote, with the legacy derivation as fallback. */
export function storedTaxBps(doc: { taxBps: number; subtotalMinor: bigint; taxMinor: bigint }): number {
  if (doc.taxBps === 0 && doc.taxMinor > 0n) return deriveTaxBps(doc.subtotalMinor, doc.taxMinor);
  return doc.taxBps;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a YYYY-MM-DD day into a UTC midnight Date. */
export function parseDay(value: string, field = 'date'): Date {
  if (!DAY_RE.test(value)) throw DomainError.validation(`Invalid ${field}: ${value}`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw DomainError.validation(`Invalid ${field}: ${value}`);
  return d;
}

export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days between two UTC dates (positive when `later` is after `earlier`). */
export function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / 86_400_000);
}

/**
 * CSV cell with quoting and formula-injection neutralisation: a value starting with `=`, `+`, `-`,
 * `@`, tab or carriage return would be evaluated by spreadsheet software, so it is prefixed with an
 * apostrophe and quoted (user-supplied titles, names and e-mails cross tenants through exports).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = value instanceof Date ? value.toISOString() : String(value);
  // Plain signed numbers (e.g. "-120.00") are legitimate values, not formulas.
  const formula = /^[\t\r]*[=+\-@]/.test(str) && !/^-?\d+(\.\d+)?$/.test(str);
  if (formula) str = `'${str}`;
  return formula || /[",\n\r\t]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Runs `fn` again when the database rejects a duplicate document number (two concurrent
 * creations computed the same sequence). Any other error is rethrown as-is.
 */
export async function retryOnUniqueViolation<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastError = err;
    }
  }
  throw new DomainError(
    ErrorCode.CONFLICT,
    'Could not allocate a document number, please retry',
    HttpStatus.CONFLICT,
    { cause: lastError instanceof Error ? lastError.message : String(lastError) },
  );
}

/**
 * Sequential numbering per organisation and year: `INV-2026-0001`, `QUO-2026-0001`.
 * Numbers are never reused (cancelled documents keep theirs), so count + 1 is the next value;
 * the unique index (organizationId, number) plus retryOnUniqueViolation handle races.
 */
export async function allocateDocumentNumber(
  db: PrismaTransactionClient,
  model: 'invoice' | 'quote',
  organizationId: string,
  now = new Date(),
): Promise<string> {
  const prefix = `${model === 'invoice' ? 'INV' : 'QUO'}-${now.getUTCFullYear()}-`;
  const where = { organizationId, number: { startsWith: prefix } };
  const count = model === 'invoice' ? await db.invoice.count({ where }) : await db.quote.count({ where });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

export function clampNonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

/**
 * Customer-side notification recipients of a document: active OWNER / ADMIN / MEMBER of the
 * counterparty organisation, ONLY when that organisation accepted the link. A free-text customer
 * e-mail or a pending / declined / revoked link never notifies anybody on the platform (consent).
 */
export async function linkedCustomerUserIds(
  db: Pick<PrismaTransactionClient, 'organizationMember'>,
  counterparty: { linkedOrganizationId: string | null; linkStatus: string } | null | undefined,
): Promise<string[]> {
  if (!counterparty || counterparty.linkStatus !== 'ACCEPTED' || !counterparty.linkedOrganizationId)
    return [];
  const members = await db.organizationMember.findMany({
    where: {
      organizationId: counterparty.linkedOrganizationId,
      role: { in: ['OWNER', 'ADMIN', 'MEMBER'] },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}
