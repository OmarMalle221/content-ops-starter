import { minorToDecimalString, DocumentScanStatus, type DocumentScanDto } from '@dfn/shared';

/** Convert a BigInt minor amount into the wire format { minor, decimal, currency }. */
export function moneyDto(amountMinor: bigint | null | undefined, currencyCode: string) {
  if (amountMinor === null || amountMinor === undefined) return null;
  return {
    minor: amountMinor.toString(),
    decimal: minorToDecimalString(amountMinor, currencyCode),
    currency: currencyCode,
  };
}

/** Install BigInt JSON serialisation once per process (minor units as strings). */
export function installBigIntJson() {
  const proto = BigInt.prototype as unknown as { toJSON?: () => string };
  if (!proto.toJSON) {
    Object.defineProperty(BigInt.prototype, 'toJSON', {
      value: function toJSON(this: bigint) {
        return this.toString();
      },
      configurable: true,
    });
  }
}

/**
 * Document referenced from another resource (milestone evidence, dispute evidence or attachment):
 * the summary it was selected with, its antivirus verdict and — unless the verdict is INFECTED,
 * which the download endpoint refuses — its download URL. Same rule as `DocumentsService.toDto`.
 */
export function linkedDocumentDto<
  T extends { id: string; scanStatus: string; scanEngine: string | null; scannedAt: Date | null },
>(doc: T) {
  const { scanStatus, scanEngine, scannedAt, ...summary } = doc;
  const scan: DocumentScanDto = {
    status: scanStatus as DocumentScanStatus,
    engine: scanEngine,
    scannedAt: scannedAt?.toISOString() ?? null,
  };
  return {
    ...summary,
    scan,
    downloadUrl: scan.status === DocumentScanStatus.INFECTED ? null : `/api/v1/documents/${doc.id}/download`,
  };
}
