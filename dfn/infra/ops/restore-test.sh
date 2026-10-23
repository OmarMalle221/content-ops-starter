#!/usr/bin/env bash
# Restore drill (SECURITY.md §12): backup → restore into a scratch database → checks → cleanup.
# SANDBOX ONLY — fictitious data and amounts. Never touches the source database except to read it.
#
# Usage: infra/ops/restore-test.sh [--source-url URL] [--dump FILE] [--scratch-db NAME] [--keep]
#                                  [--allow-count-drift] [--allow-differences] [--allow-empty]
#
#   --source-url URL     database to back up (default: DATABASE_URL)
#   --dump FILE          drill an existing backup (e.g. last night's) instead of taking a new one;
#                        the source URL then only locates the server for the scratch database
#   --scratch-db NAME    scratch database name (default: dfn_restore_drill_<UTC timestamp>)
#   --keep               keep the scratch database for inspection (dropped by default)
#   --allow-count-drift  source and restored row counts may differ (live source being written)
#   --allow-differences  ledger reconciliation differences are reported but do not fail the drill
#   --allow-empty        with --dump: a backup without users or ledger rows passes (fresh database)
#
# Checks: 1) backup.sh + restore.sh succeed (checksum, decryption, pg_restore in one transaction),
#            in place too: over a newer schema, and refusing to drop a managed key newer than the dump
#         2) prisma migrate status: the restored schema is up to date with the code's migrations
#         3) row counts per key table: restored == source (or > 0 for the ledger when --dump)
#         4) ledger: LedgerService.reconcile() on the restored database — 0 unbalanced transaction,
#            global debits == credits per currency (infra/ops/reconcile-ledger.ts)
# Encryption: when BACKUP_AGE_RECIPIENT(S_FILE) is set the drill also proves the age round trip and
# needs BACKUP_AGE_IDENTITY_FILE to decrypt. Exit code 0 only if every check passes.
set -euo pipefail
umask 077
DFN_SCRIPT=restore-test
# shellcheck source=infra/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SOURCE_URL="${DATABASE_URL:-}"
DUMP=""
SCRATCH_DB=""
KEEP=false
ALLOW_DRIFT=false
ALLOW_DIFFERENCES=false
ALLOW_EMPTY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-url) SOURCE_URL="$2"; shift 2 ;;
    --dump) DUMP="$2"; shift 2 ;;
    --scratch-db) SCRATCH_DB="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --allow-empty) ALLOW_EMPTY=true; shift ;;
    --allow-count-drift) ALLOW_DRIFT=true; shift ;;
    --allow-differences) ALLOW_DIFFERENCES=true; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$SOURCE_URL" ]] || die "--source-url or DATABASE_URL is required"
[[ -z "$DUMP" || -f "$DUMP" ]] || die "backup file not found: $DUMP"
need psql pg_dump pg_restore node

parse_pg_url "$SOURCE_URL"
SOURCE_DB="$PGDATABASE"
SCHEMA="$DFN_PG_SCHEMA"
SCRATCH_DB="${SCRATCH_DB:-dfn_restore_drill_$(date -u +%Y%m%d%H%M%S)}"
assert_safe_db_name "$SCRATCH_DB"
[[ "$SCRATCH_DB" != "$SOURCE_DB" ]] || die "the scratch database must differ from the source database"
SCRATCH_URL="$(url_with_database "$SOURCE_URL" "$SCRATCH_DB")"
ADMIN_DB="${RESTORE_ADMIN_DB:-postgres}"

admin_sql() { PGDATABASE="$ADMIN_DB" psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }

[[ -z "$(admin_sql "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH_DB'")" ]] ||
  die "scratch database $SCRATCH_DB already exists — choose another --scratch-db"

WORK="$(mktemp -d)"
SCRATCH_OWNED=false
cleanup() {
  local rc=$?
  if $SCRATCH_OWNED && ! $KEEP; then
    if (parse_pg_url "$SOURCE_URL" && admin_sql "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null); then
      log "scratch database $SCRATCH_DB dropped"
    else
      log "WARNING: could not drop scratch database $SCRATCH_DB — drop it manually"
    fi
  elif $SCRATCH_OWNED; then
    log "scratch database kept: $(redact_url "$SCRATCH_URL")"
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

FAILURES=()
fail() {
  FAILURES+=("$1")
  log "FAIL: $1"
}
drill_started="$(now_ms)"
log "source: $(redact_url "$SOURCE_URL") · scratch: $SCRATCH_DB"

# ── 1. Backup ────────────────────────────────────────────────────────────────
t="$(now_ms)"
if [[ -z "$DUMP" ]]; then
  DUMP="$(BACKUP_DATABASE_URL="$SOURCE_URL" bash "$DFN_OPS_DIR/backup.sh" --dir "$WORK/backups" --no-prune --label drill)"
fi
backup_s="$(elapsed "$t")"
log "backup: $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1), ${backup_s} s)"

count_rows() {
  # count_rows URL TABLE → row count, or "absent" when the table does not exist.
  (
    parse_pg_url "$1"
    reg="$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('\"$SCHEMA\".\"$2\"') IS NOT NULL")"
    if [[ "$reg" == "t" ]]; then
      psql -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM \"$SCHEMA\".\"$2\""
    else
      echo absent
    fi
  )
}

# ── 2. Restore into the scratch database ─────────────────────────────────────
t="$(now_ms)"
SCRATCH_OWNED=true
bash "$DFN_OPS_DIR/restore.sh" "$DUMP" --target-url "$SCRATCH_URL" --create --yes
restore_s="$(elapsed "$t")"

# In place over a newer schema (rolling back a bad release): a table that the backup does not know,
# with a foreign key to a restored table, must not make the restore abort.
(
  parse_pg_url "$SCRATCH_URL"
  psql -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE \"$SCHEMA\".\"DrillNewer\" (id int,
    m varchar(36) REFERENCES \"$SCHEMA\".\"_prisma_migrations\"(id))"
)
bash "$DFN_OPS_DIR/restore.sh" "$DUMP" --target-url "$SCRATCH_URL" --yes
[[ "$(count_rows "$SCRATCH_URL" DrillNewer 2>/dev/null || echo error)" == absent ]] ||
  fail "in-place restore kept a table the backup does not contain"

# In place over a database holding managed data keys the backup lacks (generated after the dump):
# refused by default — it would destroy the only copy of each key —, carried over with
# --keep-newer-keys (ACTIVE demoted to DECRYPT_ONLY; every document with a blob recorded under the
# newest carried-over documents key, for a full re-read by the key rotation), dropped with
# --discard-newer-keys. These checks run on a second backup of the scratch database that holds at
# least one encrypted document (so the re-read check cannot pass on an empty table); the original
# backup is restored afterwards, so the checks below compare it with the source as before.
drill_suffix="$(date -u +%H%M%S)"
scratch_sql() {
  (
    parse_pg_url "$SCRATCH_URL"
    psql -X -At -v ON_ERROR_STOP=1 -c "$1"
  )
}
key_state() {
  scratch_sql "SELECT coalesce(max(status::text || CASE WHEN \"deactivatedAt\" IS NULL THEN '' ELSE '+deactivated' END), 'absent')
    FROM \"$SCHEMA\".\"EncryptionKey\" WHERE \"keyId\" = '$1'"
}
if [[ "$(count_rows "$SCRATCH_URL" EncryptionKey)" != absent ]]; then
  # One encrypted document with a blob (fields only: no blob store is involved), when the backup has
  # an organisation member to own it (a fresh database may not).
  drill_document="$(scratch_sql "INSERT INTO \"$SCHEMA\".\"Document\" (id, \"organizationId\", \"uploadedByUserId\", title, \"fileName\",
      \"mimeType\", \"sizeBytes\", sha256, \"storageKey\", encrypted)
    SELECT gen_random_uuid(), m.\"organizationId\", m.\"userId\", 'drill', 'drill.pdf', 'application/pdf', 1,
      repeat('0', 64), 'drill/' || gen_random_uuid(), true
    FROM \"$SCHEMA\".\"OrganizationMember\" m LIMIT 1 RETURNING id")"
  mkdir -p "$WORK/backups"
  keys_dump="$WORK/backups/drill-keys.dump"
  (
    parse_pg_url "$SCRATCH_URL"
    pg_dump --format=custom --file="$keys_dump" "$PGDATABASE"
  )
  # A purpose without an ACTIVE key in the backup takes an ACTIVE drill key (the demotion is then
  # observable); the documents purpose takes two DECRYPT_ONLY keys, the newer one must be used.
  free_purpose="$(scratch_sql "SELECT p FROM unnest(ARRAY['webhooks','beneficiaries','mfa']) p
    WHERE NOT EXISTS (SELECT 1 FROM \"$SCHEMA\".\"EncryptionKey\" k WHERE k.purpose = p AND k.status = 'ACTIVE')
    ORDER BY 1 LIMIT 1")"
  active_key="kms-drill-a$drill_suffix"
  older_documents_key="kms-drill-o$drill_suffix"
  documents_key="kms-drill-d$drill_suffix"
  insert_key() {
    scratch_sql "INSERT INTO \"$SCHEMA\".\"EncryptionKey\" (id, purpose, \"keyId\", status, \"wrappedKey\",
      \"kmsProvider\", \"kmsKeyRef\", \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid(), '$1', '$2', '$3',
      '\\x00', 'local', 'drill', now() - interval '$4 minutes', now())" >/dev/null
  }
  [[ -n "$free_purpose" ]] && insert_key "$free_purpose" "$active_key" ACTIVE 0
  insert_key documents "$older_documents_key" DECRYPT_ONLY 60
  insert_key documents "$documents_key" DECRYPT_ONLY 0
  scratch_sql "CREATE TABLE \"$SCHEMA\".\"DrillSentinel\" (id int)" >/dev/null

  if bash "$DFN_OPS_DIR/restore.sh" "$keys_dump" --target-url "$SCRATCH_URL" --yes 2>"$WORK/keys-refused.txt"; then
    fail "in-place restore dropped managed data keys the backup does not contain"
  elif ! grep -q "$documents_key" "$WORK/keys-refused.txt" || [[ "$(count_rows "$SCRATCH_URL" DrillSentinel)" == absent ]] ||
    [[ -n "$free_purpose" && "$(key_state "$active_key")" != ACTIVE ]]; then
    fail "refused restore did not name the managed keys or left the database changed"
  else
    log "ok   in-place restore refused over managed keys newer than the backup"
  fi

  bash "$DFN_OPS_DIR/restore.sh" "$keys_dump" --target-url "$SCRATCH_URL" --yes --keep-newer-keys
  [[ "$(count_rows "$SCRATCH_URL" DrillSentinel)" == absent ]] || fail "--keep-newer-keys did not restore the backup"
  for key in "$documents_key" "$older_documents_key"; do
    [[ "$(key_state "$key")" == DECRYPT_ONLY+deactivated ]] ||
      fail "--keep-newer-keys did not carry $key over as DECRYPT_ONLY"
  done
  [[ -z "$free_purpose" || "$(key_state "$active_key")" == DECRYPT_ONLY+deactivated ]] ||
    fail "--keep-newer-keys did not demote the ACTIVE key to DECRYPT_ONLY"
  with_blob="$(scratch_sql "SELECT count(*) FROM \"$SCHEMA\".\"Document\" WHERE encrypted AND \"blobPurgedAt\" IS NULL")"
  marked="$(scratch_sql "SELECT count(*) FROM \"$SCHEMA\".\"Document\" WHERE encrypted AND \"blobPurgedAt\" IS NULL
    AND \"encryptionKeyId\" = '$documents_key'")"
  if [[ "$with_blob" == 0 && -z "$drill_document" ]]; then
    log "skip full re-read check (no organisation member in the backup to own a drill document)"
  elif [[ "$with_blob" == 0 ]]; then
    fail "the drill document is missing from its backup: the full re-read cannot be checked"
  elif [[ "$marked" != "$with_blob" ]]; then
    fail "--keep-newer-keys left $((with_blob - marked)) document(s) out of the full re-read (newest documents key)"
  else
    log "ok   --keep-newer-keys: keys carried over as DECRYPT_ONLY, $marked document(s) recorded under the newest documents key"
  fi

  bash "$DFN_OPS_DIR/restore.sh" "$keys_dump" --target-url "$SCRATCH_URL" --yes --discard-newer-keys
  for key in "$documents_key" "$older_documents_key" "$active_key"; do
    [[ "$(key_state "$key")" == absent ]] || fail "--discard-newer-keys kept $key"
  done
  # Back to the original backup for the checks below (no newer key left: no flag needed).
  bash "$DFN_OPS_DIR/restore.sh" "$DUMP" --target-url "$SCRATCH_URL" --yes
else
  log "skip managed-key restore checks (backup older than phase 7: no EncryptionKey table)"
fi

# ── 3. Prisma migration status of the restored schema ───────────────────────
t="$(now_ms)"
SCHEMA_FILE="${PRISMA_SCHEMA_FILE:-}"
PRISMA_CLI="${PRISMA_CLI:-}"
if [[ -z "$PRISMA_CLI" ]]; then
  for candidate in "$DFN_ROOT/packages/database/node_modules/prisma/build/index.js" \
    "$DFN_ROOT/node_modules/prisma/build/index.js" /app/node_modules/prisma/build/index.js; do
    if [[ -f "$candidate" ]]; then PRISMA_CLI="$candidate"; break; fi
  done
fi
if [[ -z "$SCHEMA_FILE" ]]; then
  for candidate in "$DFN_ROOT/packages/database/prisma/schema.prisma" /app/apps/api/prisma/schema.prisma; do
    if [[ -f "$candidate" ]]; then SCHEMA_FILE="$candidate"; break; fi
  done
fi
if [[ -z "$PRISMA_CLI" || -z "$SCHEMA_FILE" ]]; then
  fail "prisma CLI or schema not found (set PRISMA_CLI / PRISMA_SCHEMA_FILE)"
elif DATABASE_URL="$SCRATCH_URL" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
  node "$PRISMA_CLI" migrate status --schema "$SCHEMA_FILE" >"$WORK/migrate-status.txt" 2>&1; then
  log "ok   prisma migrate status: $(grep -m1 -E 'up to date|migrations found' "$WORK/migrate-status.txt" || echo 'up to date')"
else
  sed 's/^/       /' "$WORK/migrate-status.txt" >&2
  fail "prisma migrate status: restored schema is not up to date with prisma/migrations"
fi

# ── 4. Row counts per key table ──────────────────────────────────────────────
TABLES=(_prisma_migrations User Organization OrganizationMember Transaction Wallet LedgerAccount
  LedgerTransaction LedgerEntry BalanceSnapshot ReconciliationJob Transfer Invoice Document AuditLog
  RiskAlert RegulatoryGate WebAuthnCredential)
compare_source=true
[[ "$DUMP" == "$WORK/backups/"* ]] || compare_source=false
printf '%-22s %12s %12s\n' table source restored >&2
for table in "${TABLES[@]}"; do
  restored="$(count_rows "$SCRATCH_URL" "$table")"
  if $compare_source; then
    source_count="$(count_rows "$SOURCE_URL" "$table")"
  else
    source_count="-"
  fi
  status=""
  if $compare_source && [[ "$restored" != "$source_count" ]]; then
    if $ALLOW_DRIFT; then status="drift (allowed)"; else
      status="MISMATCH"
      fail "row count mismatch on $table (source $source_count, restored $restored)"
    fi
  fi
  printf '%-22s %12s %12s %s\n' "$table" "$source_count" "$restored" "$status" >&2
done
[[ "$(count_rows "$SCRATCH_URL" _prisma_migrations)" =~ ^[1-9] ]] || fail "no applied migration in the restored database"
if ! $compare_source && ! $ALLOW_EMPTY; then
  # No source to compare with: an empty or wrong-database backup must not pass the drill.
  for table in User LedgerAccount LedgerTransaction LedgerEntry; do
    [[ "$(count_rows "$SCRATCH_URL" "$table")" =~ ^[1-9] ]] ||
      fail "$table is empty in the restored backup (--allow-empty for a fresh database)"
  done
fi

# ── 5. Ledger reconciliation on the restored database ───────────────────────
RUNNER="${DFN_RECONCILE_RUNNER:-auto}"
DIST="$DFN_ROOT/apps/api/dist/reconcile-ledger.js"
[[ -f "$DIST" ]] || DIST=/app/apps/api/dist/reconcile-ledger.js
if [[ "$RUNNER" == auto ]]; then
  if [[ -f "$DIST" ]]; then RUNNER=dist; else RUNNER=source; fi
fi
reconcile_args=()
$ALLOW_DIFFERENCES && reconcile_args+=(--allow-differences)
log "ledger reconciliation (runner: $RUNNER)"
case "$RUNNER" in
  dist)
    [[ -f "$DIST" ]] || die "compiled reconcile script not found (pnpm build:api)"
    RECONCILE_DATABASE_URL="$SCRATCH_URL" node --enable-source-maps "$DIST" "${reconcile_args[@]}" || reconcile_rc=$?
    ;;
  source)
    (cd "$DFN_ROOT/apps/api" && RECONCILE_DATABASE_URL="$SCRATCH_URL" node -r ts-node/register/transpile-only \
      -r tsconfig-paths/register ../../infra/ops/reconcile-ledger.ts "${reconcile_args[@]}") || reconcile_rc=$?
    ;;
  *) die "DFN_RECONCILE_RUNNER must be auto, dist or source" ;;
esac
case "${reconcile_rc:-0}" in
  0) ;;
  1) fail "ledger reconciliation: unbalanced transactions, global debit/credit mismatch or differences" ;;
  *) fail "ledger reconciliation could not run (exit ${reconcile_rc})" ;;
esac
checks_s="$(elapsed "$t")"

# ── Report ───────────────────────────────────────────────────────────────────
log "timings: backup ${backup_s} s · restore ${restore_s} s · checks ${checks_s} s · total $(elapsed "$drill_started") s"
log "note: document blobs (STORAGE_DIR / S3 bucket) are not part of the database dump — see RUNBOOK §6"
if ((${#FAILURES[@]} > 0)); then
  log "RESTORE DRILL FAILED — ${#FAILURES[@]} check(s) failed"
  exit 1
fi
log "RESTORE DRILL PASSED"
