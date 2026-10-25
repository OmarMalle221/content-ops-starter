import { describe, expect, it } from 'vitest';
import { documentDownloadPath, linkedDocumentDto } from '../src/common/serialize';

/**
 * Documents referenced from another resource (evidence, attachments): the download path is
 * relative to the API — partners resolve it against API_PUBLIC_URL, the web prepends /api — and
 * is withheld for what the download endpoint refuses (INFECTED, deleted).
 */
describe('linkedDocumentDto', () => {
  const base = {
    id: '6f1c2a0e-2c5d-4b1a-9e3f-0d2c4b6a8e10',
    title: 'Connaissement',
    kind: 'BILL_OF_LADING',
    fileName: 'bol.pdf',
    scanEngine: 'sandbox-eicar',
    scannedAt: new Date('2026-10-17T10:00:00Z'),
  };

  it('keeps the summary, exposes the verdict and an API-relative download path', () => {
    const dto = linkedDocumentDto({ ...base, scanStatus: 'CLEAN', deletedAt: null });
    expect(dto).toEqual({
      id: base.id,
      title: base.title,
      kind: base.kind,
      fileName: base.fileName,
      scan: { status: 'CLEAN', engine: 'sandbox-eicar', scannedAt: '2026-10-17T10:00:00.000Z' },
      deleted: false,
      downloadUrl: `/v1/documents/${base.id}/download`,
    });
    expect(documentDownloadPath(base.id)).not.toMatch(/^\/api\//);
    expect('scanStatus' in dto).toBe(false);
    expect('deletedAt' in dto).toBe(false);
  });

  it('withholds the download path for an INFECTED or a deleted document', () => {
    expect(linkedDocumentDto({ ...base, scanStatus: 'INFECTED', deletedAt: null })).toMatchObject({
      scan: { status: 'INFECTED' },
      deleted: false,
      downloadUrl: null,
    });
    expect(linkedDocumentDto({ ...base, scanStatus: 'CLEAN', deletedAt: new Date() })).toMatchObject({
      deleted: true,
      downloadUrl: null,
    });
    // Callers that did not select deletedAt (none today) still get a well-formed DTO.
    expect(linkedDocumentDto({ ...base, scanStatus: 'NOT_SCANNED', scannedAt: null })).toMatchObject({
      scan: { status: 'NOT_SCANNED', scannedAt: null },
      deleted: false,
      downloadUrl: `/v1/documents/${base.id}/download`,
    });
  });
});
