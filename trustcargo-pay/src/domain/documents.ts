/** Document rules shared by the service and the UI. */
import type { DocumentType, ExtractedReferences, PartyRole } from './model';
import { normalizeVin } from './vehicle/vin';
import { namesMatch } from './risk/names';

export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

/** Detects the real file type from its first bytes; the client-declared type is never trusted. */
export function sniffMimeType(bytes: Uint8Array): AllowedMime | undefined {
    const b = bytes;
    if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
    if (
        b.length >= 8 &&
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
    )
        return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (
        b.length >= 12 &&
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
    )
        return 'image/webp';
    return undefined;
}

export function sanitizeFileName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? 'document';
    const cleaned = base
        .normalize('NFKD')
        .replace(/[^\w.\- ]+/g, '')
        .replace(/\s+/g, '_')
        .slice(0, 120);
    return cleaned || 'document';
}

/** Which document types each party role may upload. Identity documents only go through the KYC provider. */
export const UPLOAD_PERMISSIONS: Record<PartyRole, DocumentType[]> = {
    SELLER: [
        'INVOICE',
        'TITLE',
        'CONTRACT',
        'INSPECTION_REPORT',
        'PHOTO',
        'BILL_OF_LADING',
        'EXPORT_DECLARATION',
        'DELIVERY_PROOF',
        'OTHER'
    ],
    BUYER: ['DELIVERY_PROOF', 'PHOTO', 'CONTRACT', 'OTHER'],
    INSPECTOR: ['INSPECTION_REPORT', 'PHOTO'],
    FREIGHT_FORWARDER: ['BILL_OF_LADING', 'EXPORT_DECLARATION', 'DELIVERY_PROOF', 'PHOTO']
};

/** Default visibility by type (principle of least privilege for third parties). */
export function defaultVisibility(type: DocumentType, uploaderRole: PartyRole): PartyRole[] {
    const roles = new Set<PartyRole>(['SELLER', 'BUYER', uploaderRole]);
    if (['INSPECTION_REPORT', 'PHOTO', 'TITLE'].includes(type)) roles.add('INSPECTOR');
    if (['BILL_OF_LADING', 'EXPORT_DECLARATION', 'DELIVERY_PROOF'].includes(type)) roles.add('FREIGHT_FORWARDER');
    return [...roles];
}

export type ComparableField = 'vin' | 'ownerName' | 'amount' | 'consignee' | 'portOfDischarge';

export interface ComparisonCell {
    documentId: string;
    documentType: DocumentType;
    value?: string;
    status: 'MATCH' | 'MISMATCH' | 'NOT_PRESENT';
}

export interface ComparisonRow {
    field: ComparableField;
    expected?: string;
    cells: ComparisonCell[];
}

/**
 * Cross-document reference comparison. A full match only means the *declared or extracted*
 * references are consistent — it never establishes that a document is authentic.
 */
export function compareReferences(
    expected: {
        vin?: string;
        sellerNames: string[];
        buyerNames: string[];
        amountMinor?: string;
        currency?: string;
        dischargePorts: string[];
    },
    documents: { id: string; type: DocumentType; extracted: ExtractedReferences }[]
): ComparisonRow[] {
    const rows: ComparisonRow[] = [
        { field: 'vin', expected: expected.vin, cells: [] },
        { field: 'ownerName', expected: expected.sellerNames[0], cells: [] },
        { field: 'amount', expected: expected.amountMinor ? `${expected.amountMinor} ${expected.currency}` : undefined, cells: [] },
        { field: 'consignee', expected: expected.buyerNames[0], cells: [] },
        { field: 'portOfDischarge', expected: expected.dischargePorts.join(' / ') || undefined, cells: [] }
    ];
    for (const doc of documents) {
        const e = doc.extracted;
        const cell = (value: string | undefined, ok: (v: string) => boolean): ComparisonCell => ({
            documentId: doc.id,
            documentType: doc.type,
            value,
            status: value === undefined ? 'NOT_PRESENT' : ok(value) ? 'MATCH' : 'MISMATCH'
        });
        rows[0]!.cells.push(cell(e.vin, (v) => !!expected.vin && normalizeVin(v) === normalizeVin(expected.vin)));
        rows[1]!.cells.push(cell(e.ownerName, (v) => expected.sellerNames.some((n) => namesMatch(n, v))));
        rows[2]!.cells.push(
            cell(
                e.amount ? `${e.amount.amountMinor} ${e.amount.currency}` : undefined,
                () => e.amount!.amountMinor === expected.amountMinor && e.amount!.currency === expected.currency
            )
        );
        rows[3]!.cells.push(cell(e.consignee, (v) => expected.buyerNames.some((n) => namesMatch(n, v))));
        rows[4]!.cells.push(cell(e.portOfDischarge, (v) => expected.dischargePorts.some((p) => namesMatch(p, v))));
    }
    return rows;
}
