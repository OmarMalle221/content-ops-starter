import type { Prisma } from '@dfn/database';
import { KeyPurpose } from '@dfn/shared';
import { LEGACY_KEY_ID } from '../../common/keyring';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { SEALED_COLUMNS, countByKeyId, countWithKeyId } from './sealed-columns';

/**
 * How many stored values each key id still seals — the facts behind the key console, the
 * retirement guard of managed keys and the legacy-key checklist. Counts only, never values.
 *
 * Documents: a blob is stored until DOCUMENT_PURGE removes it (Document.blobPurgedAt). A deleted
 * document keeps its blob for its retention period, so it is re-sealed by the rotation job like a
 * live one and its key must stay available until the purge.
 */

/** Encrypted documents whose blob is still stored (live, or deleted and retained until the purge). */
export const STORED_BLOBS = { encrypted: true, blobPurgedAt: null } as const;
/** The deleted part of STORED_BLOBS. */
const DELETED_BLOBS = { ...STORED_BLOBS, deletedAt: { not: null } } as const;

/** Stored documents whose recorded key id is not the active one (null = legacy). */
export function pendingDocumentsWhere(activeKeyId: string): Prisma.DocumentWhereInput {
  if (activeKeyId === LEGACY_KEY_ID) return { ...STORED_BLOBS, encryptionKeyId: { not: null } };
  return { ...STORED_BLOBS, OR: [{ encryptionKeyId: null }, { encryptionKeyId: { not: activeKeyId } }] };
}

/** Pending documents recorded under neither the active key nor `keyId` (explicit NULL branch: SQL). */
function otherPendingDocumentsWhere(activeKeyId: string, keyId: string): Prisma.DocumentWhereInput {
  if (activeKeyId === LEGACY_KEY_ID)
    return { ...STORED_BLOBS, encryptionKeyId: { not: null, notIn: [keyId] } };
  return {
    ...STORED_BLOBS,
    OR: [{ encryptionKeyId: null }, { encryptionKeyId: { notIn: [activeKeyId, keyId] } }],
  };
}

/** Values (stored blobs for documents) per key id of a purpose ("legacy" for values without header). */
export async function countsByKeyId(
  prisma: PrismaService,
  purpose: KeyPurpose,
): Promise<Map<string, number>> {
  if (purpose === KeyPurpose.DOCUMENTS) {
    const groups = await prisma.document.groupBy({
      by: ['encryptionKeyId'],
      where: STORED_BLOBS,
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.encryptionKeyId ?? LEGACY_KEY_ID, g._count._all]));
  }
  const totals = new Map<string, number>();
  for (const spec of SEALED_COLUMNS.filter((c) => c.purpose === purpose)) {
    for (const [keyId, count] of await countByKeyId(prisma, spec)) {
      totals.set(keyId, (totals.get(keyId) ?? 0) + count);
    }
  }
  return totals;
}

/** Blobs of deleted, not yet purged documents, per key id (a subset of countsByKeyId(documents)). */
export async function deletedBlobCountsByKeyId(prisma: PrismaService): Promise<Map<string, number>> {
  const groups = await prisma.document.groupBy({
    by: ['encryptionKeyId'],
    where: DELETED_BLOBS,
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.encryptionKeyId ?? LEGACY_KEY_ID, g._count._all]));
}

export interface LegacyUsage {
  /** Values (stored document blobs) still sealed with DOCUMENT_ENCRYPTION_KEY. */
  values: number;
  /** Of which blobs of deleted documents retained until the purge (documents only). */
  deletedBlobs: number;
}

/** What still depends on the legacy key, per purpose. */
export async function legacyUsage(prisma: PrismaService): Promise<Record<KeyPurpose, LegacyUsage>> {
  const deleted = await deletedBlobCountsByKeyId(prisma);
  const usage = {} as Record<KeyPurpose, LegacyUsage>;
  for (const purpose of Object.values(KeyPurpose)) {
    const counts = await countsByKeyId(prisma, purpose);
    usage[purpose] = {
      values: counts.get(LEGACY_KEY_ID) ?? 0,
      deletedBlobs: purpose === KeyPurpose.DOCUMENTS ? (deleted.get(LEGACY_KEY_ID) ?? 0) : 0,
    };
  }
  return usage;
}

export interface KeyReferences {
  /** Values (stored document blobs, deleted ones included) sealed with the key. */
  values: number;
  /** Of which blobs of deleted documents retained until the purge (documents only). */
  deletedBlobs: number;
  /**
   * Other stored documents still awaiting rotation (documents only). A rotation interrupted
   * between the blob swap and the row update leaves a blob sealed with a newer key than the one its
   * row records, so no documents key is retired before every stored blob is on the active key.
   */
  pendingDocuments: number;
  /** values + pendingDocuments: the key can be retired only at 0. */
  total: number;
}

/** Everything that still needs `keyId` (a managed key id) to be readable. */
export async function keyReferences(
  prisma: PrismaService,
  purpose: KeyPurpose,
  keyId: string,
  activeKeyId: string,
): Promise<KeyReferences> {
  let values = 0;
  let deletedBlobs = 0;
  let pendingDocuments = 0;
  if (purpose === KeyPurpose.DOCUMENTS) {
    [values, deletedBlobs, pendingDocuments] = await Promise.all([
      prisma.document.count({ where: { ...STORED_BLOBS, encryptionKeyId: keyId } }),
      prisma.document.count({ where: { ...DELETED_BLOBS, encryptionKeyId: keyId } }),
      prisma.document.count({ where: otherPendingDocumentsWhere(activeKeyId, keyId) }),
    ]);
  } else {
    for (const spec of SEALED_COLUMNS.filter((c) => c.purpose === purpose)) {
      values += await countWithKeyId(prisma, spec, keyId);
    }
  }
  return { values, deletedBlobs, pendingDocuments, total: values + pendingDocuments };
}
