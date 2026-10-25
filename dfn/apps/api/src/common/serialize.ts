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
 * the summary it was selected with, its antivirus verdict, whether it was deleted and — unless
 * it is INFECTED or deleted, which the download endpoint refuses — its download path. The path is
 * relative to the API (`/v1/...`, the convention of `DocumentsService.toDto`): partners calling
 * the API directly resolve it against `API_PUBLIC_URL`, the web prepends its `/api` proxy prefix.
 */
export function linkedDocumentDto<
  T extends {
    id: string;
    scanStatus: string;
    scanEngine: string | null;
    scannedAt: Date | null;
    deletedAt?: Date | null;
  },
>(doc: T) {
  const { scanStatus, scanEngine, scannedAt, deletedAt, ...summary } = doc;
  const scan: DocumentScanDto = {
    status: scanStatus as DocumentScanStatus,
    engine: scanEngine,
    scannedAt: scannedAt?.toISOString() ?? null,
  };
  const deleted = Boolean(deletedAt);
  return {
    ...summary,
    scan,
    deleted,
    downloadUrl: scan.status === DocumentScanStatus.INFECTED || deleted ? null : documentDownloadPath(doc.id),
  };
}

/** API-relative download path of a document (never a web-proxy path). */
export function documentDownloadPath(id: string): string {
  return `/v1/documents/${id}/download`;
}
