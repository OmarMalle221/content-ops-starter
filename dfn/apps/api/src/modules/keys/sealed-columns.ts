import { Prisma } from '@dfn/database';
import { KeyPurpose } from '@dfn/shared';
import { LEGACY_KEY_ID } from '../../common/keyring';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Database columns holding values sealed as strings by the key ring
 * (`k2.<purpose>.<keyId>.<base64>`, or bare base64 for the legacy layout).
 *
 * The queries below are raw SQL on purpose: they group and filter on the key id embedded in the
 * value (prefix comparison with left(), no LIKE wildcards) and update with a compare-and-set
 * that leaves `updatedAt` untouched — re-encryption is not a business change of the row.
 * Table and column names come only from this constant list, never from input.
 */
export interface SealedColumn {
  purpose: KeyPurpose;
  /** Human-readable source shown in the admin console and summaries. */
  source: string;
  table: string;
  column: string;
}

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  { purpose: KeyPurpose.MFA, source: 'users.mfaSecretEnc', table: 'User', column: 'mfaSecretEnc' },
  {
    purpose: KeyPurpose.WEBHOOKS,
    source: 'webhookSubscription.secretEnc',
    table: 'WebhookSubscription',
    column: 'secretEnc',
  },
  {
    purpose: KeyPurpose.BENEFICIARIES,
    source: 'beneficiary.accountIdentifierEnc',
    table: 'Beneficiary',
    column: 'accountIdentifierEnc',
  },
];

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function identifiers(spec: SealedColumn) {
  return { table: Prisma.raw(`"${spec.table}"`), column: Prisma.raw(`"${spec.column}"`) };
}

/** SQL predicate: the value was NOT sealed with `activeKeyId` (i.e. it needs rotation). */
function needsRotation(spec: SealedColumn, activeKeyId: string): Prisma.Sql {
  const { column } = identifiers(spec);
  if (activeKeyId === LEGACY_KEY_ID) return Prisma.sql`left(${column}, 3) = 'k2.'`;
  const prefix = `k2.${spec.purpose}.${activeKeyId}.`;
  return Prisma.sql`left(${column}, ${prefix.length}::int) <> ${prefix}`;
}

/** Number of values per key id ("legacy" for values without a key ring header). */
export async function countByKeyId(db: PrismaService, spec: SealedColumn): Promise<Map<string, number>> {
  const { table, column } = identifiers(spec);
  const rows = await db.$queryRaw<Array<{ keyId: string; count: number }>>`
    SELECT CASE WHEN left(${column}, 3) = 'k2.' THEN split_part(${column}, '.', 3) ELSE ${LEGACY_KEY_ID} END AS "keyId",
           count(*)::int AS "count"
    FROM ${table}
    WHERE ${column} IS NOT NULL
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.keyId, Number(r.count)]));
}

/** Number of values sealed with exactly `keyId` (never "legacy": use countByKeyId for that). */
export async function countWithKeyId(db: PrismaService, spec: SealedColumn, keyId: string): Promise<number> {
  const { table, column } = identifiers(spec);
  const prefix = `k2.${spec.purpose}.${keyId}.`;
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS "count" FROM ${table}
    WHERE ${column} IS NOT NULL AND left(${column}, ${prefix.length}::int) = ${prefix}`;
  return Number(rows[0]?.count ?? 0);
}

export async function countPending(
  db: PrismaService,
  spec: SealedColumn,
  activeKeyId: string,
): Promise<number> {
  const { table, column } = identifiers(spec);
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS "count" FROM ${table}
    WHERE ${column} IS NOT NULL AND ${needsRotation(spec, activeKeyId)}`;
  return Number(rows[0]?.count ?? 0);
}

/** Next page (by id) of rows whose value needs rotation. */
export async function pendingRows(
  db: PrismaService,
  spec: SealedColumn,
  activeKeyId: string,
  afterId: string,
  take: number,
  /** Inclusive upper bound of the id range (second half of a wrapped scan). */
  untilId?: string,
): Promise<Array<{ id: string; value: string }>> {
  const { table, column } = identifiers(spec);
  const upper = untilId ? Prisma.sql`AND id <= ${untilId}::uuid` : Prisma.empty;
  return db.$queryRaw<Array<{ id: string; value: string }>>`
    SELECT id::text AS "id", ${column} AS "value" FROM ${table}
    WHERE ${column} IS NOT NULL AND ${needsRotation(spec, activeKeyId)} AND id > ${afterId}::uuid ${upper}
    ORDER BY id
    LIMIT ${take}::int`;
}

/** Replaces a sealed value only if it is still the one that was read (compare-and-set). */
export async function replaceIfUnchanged(
  db: PrismaService,
  spec: SealedColumn,
  id: string,
  previous: string,
  next: string,
): Promise<boolean> {
  const { table, column } = identifiers(spec);
  const count = await db.$executeRaw`
    UPDATE ${table} SET ${column} = ${next} WHERE id = ${id}::uuid AND ${column} = ${previous}`;
  return count === 1;
}
