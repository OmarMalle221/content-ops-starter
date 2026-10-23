#!/usr/bin/env bash
# Restore a PostgreSQL backup produced by backup.sh into a target database.
# SANDBOX ONLY — fictitious data. Restoring REPLACES the objects of the target database: the script
# asks for confirmation (type the database name) unless --yes is given.
#
# Usage: infra/ops/restore.sh <backup.dump[.age|.gpg]> [--target-url URL] [--create] [--jobs N] [--yes]
#                             [--keep-newer-keys | --discard-newer-keys]
#
#   --target-url URL  target database (default: RESTORE_DATABASE_URL, then DATABASE_URL)
#   --create          create the target database first (it must not exist); otherwise the target
#                     must exist and its schema (?schema=, default public) is dropped with
#                     everything in it, then restored — in the same transaction unless --jobs
#   --jobs N          parallel restore (faster, NOT atomic); default is a single transaction
#   --yes             skip the interactive confirmation (required when stdin is not a terminal)
#
# KMS-managed data keys (table EncryptionKey, ADR-0014) exist only in the database and its backups.
# Restoring over a database that holds ACTIVE or DECRYPT_ONLY keys the backup does not contain would
# destroy the only copy of each: values and blobs sealed with them since the backup would become
# unreadable for good. The restore then REFUSES and lists them, unless one of:
#   --keep-newer-keys     carry those keys over, as DECRYPT_ONLY, in the same transaction (not with
#                         --jobs; the backup must contain the EncryptionKey table). Blobs live outside
#                         the database and may have been re-sealed with such a key since the backup:
#                         when a documents key is carried over, every restored document that still
#                         has a blob is recorded under it, so ENCRYPTION_KEY_ROTATION re-opens each
#                         blob (row repaired, blob re-sealed with the active key) and no carried-over
#                         key can be retired before the last one is done (RUNBOOK §7)
#   --discard-newer-keys  drop them anyway — only when the blobs are restored from a point in time
#                         before those keys were activated (RUNBOOK §7)
#
# Environment
#   BACKUP_AGE_IDENTITY_FILE  age identity used to decrypt *.age backups
#   (gpg backups are decrypted with the caller's gpg keyring / agent)
#   RESTORE_ADMIN_DB          maintenance database used by --create (default: postgres)
set -euo pipefail
umask 077
DFN_SCRIPT=restore
# shellcheck source=infra/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FILE=""
TARGET_URL="${RESTORE_DATABASE_URL:-${DATABASE_URL:-}}"
CREATE=false
JOBS=""
YES=false
NEWER_KEYS=refuse
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-url) TARGET_URL="$2"; shift 2 ;;
    --create) CREATE=true; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --yes | -y) YES=true; shift ;;
    --keep-newer-keys) NEWER_KEYS=keep; shift ;;
    --discard-newer-keys) NEWER_KEYS=discard; shift ;;
    -h | --help) sed -n '2,33p' "$0"; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *)
      [[ -z "$FILE" ]] || die "only one backup file can be restored"
      FILE="$1"
      shift
      ;;
  esac
done
[[ -n "$FILE" ]] || die "usage: restore.sh <backup file> [--target-url URL] [--create] [--yes]"
[[ -f "$FILE" ]] || die "backup file not found: $FILE"
[[ -n "$TARGET_URL" ]] || die "--target-url, RESTORE_DATABASE_URL or DATABASE_URL is required"
[[ -z "$JOBS" || "$JOBS" =~ ^[1-9][0-9]?$ ]] || die "--jobs must be an integer between 1 and 99"
need pg_restore psql sha256sum

parse_pg_url "$TARGET_URL"
TARGET_DB="$PGDATABASE"
$CREATE && assert_safe_db_name "$TARGET_DB"

# 1. Integrity: checksum written by backup.sh, when present.
if [[ -f "$FILE.sha256" ]]; then
  (cd "$(dirname "$FILE")" && sha256sum --check --status "$(basename "$FILE").sha256") ||
    die "checksum mismatch for $(basename "$FILE") — refusing to restore"
  log "checksum OK ($(basename "$FILE").sha256)"
else
  log "no .sha256 next to the backup — integrity not verified by checksum"
fi

# 2. Confirmation (never print credentials: host, port and database name only).
mode="drop schema $DFN_PG_SCHEMA of the existing database (CASCADE) and restore it"
$CREATE && mode="create a new database"
if ! $YES; then
  [[ -t 0 ]] || die "refusing to restore non-interactively without --yes"
  printf '\n  Backup : %s\n  Target : %s:%s/%s\n  Action : %s\n\n' \
    "$(basename "$FILE")" "$PGHOST" "$PGPORT" "$TARGET_DB" "$mode" >&2
  read -r -p "  Type the target database name to confirm: " answer
  [[ "$answer" == "$TARGET_DB" ]] || die "confirmation does not match — aborted"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 3. Decrypt to a private temporary file when needed.
ARCHIVE="$FILE"
case "$FILE" in
  *.age)
    need age
    [[ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]] || die "BACKUP_AGE_IDENTITY_FILE is required to decrypt $FILE"
    age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$WORK/backup.dump" "$FILE"
    ARCHIVE="$WORK/backup.dump"
    log "decrypted (age)"
    ;;
  *.gpg)
    need gpg
    gpg --batch --quiet --yes --decrypt --output "$WORK/backup.dump" "$FILE"
    ARCHIVE="$WORK/backup.dump"
    log "decrypted (gpg)"
    ;;
esac
pg_restore --list "$ARCHIVE" >/dev/null || die "not a readable pg_dump archive: $FILE"

# 3b. Managed data keys the target holds and the backup lacks (see the header). Read-only checks.
archive_keys() {
  # purpose:keyId of every row of the backup's EncryptionKey table (COPY data, columns by name).
  pg_restore --data-only --table=EncryptionKey --file=- "$ARCHIVE" | awk -F'\t' '
    /^COPY .*"EncryptionKey" \(/ {
      cols = $0; sub(/^[^(]*\(/, "", cols); sub(/\) FROM stdin;$/, "", cols)
      n = split(cols, c, ", "); for (i = 1; i <= n; i++) { gsub(/"/, "", c[i]); at[c[i]] = i }
      inside = 1; next
    }
    inside && $0 == "\\." { inside = 0; next }
    inside { print $(at["purpose"]) ":" $(at["keyId"]) }' | sort -u
}
archive_has_key_table() {
  # grep without -q reads all of its input: pg_restore never dies of SIGPIPE under pipefail.
  pg_restore --list "$ARCHIVE" | grep -E "^[0-9]+; [0-9]+ [0-9]+ TABLE \"?${DFN_PG_SCHEMA}\"? \"?EncryptionKey\"? " >/dev/null
}
target_keys() {
  # purpose:keyId of the keys values may still be sealed with (STAGED keys never sealed anything).
  psql -X -At -v ON_ERROR_STOP=1 -v schema="$DFN_PG_SCHEMA" -f - <<'SQL'
SELECT to_regclass(format('%I.%I', :'schema', 'EncryptionKey')) IS NOT NULL AS present \gset
\if :present
  SELECT purpose || ':' || "keyId" FROM :"schema"."EncryptionKey"
  WHERE status IN ('ACTIVE', 'DECRYPT_ONLY') ORDER BY 1;
\endif
SQL
}
NEWER=""
if ! $CREATE; then
  # A failing query or archive read aborts the restore, in the script's own words.
  held="$(target_keys 2>"$WORK/keys.err" | sort -u)" ||
    die "cannot list the managed data keys of the target database: $(tail -n 1 "$WORK/keys.err")"
  backed_up="$(archive_keys 2>"$WORK/keys.err")" ||
    die "cannot read the EncryptionKey data of $(basename "$FILE") (damaged archive?): $(tail -n 1 "$WORK/keys.err")"
  NEWER="$(comm -23 <(printf '%s\n' "$held" | sed '/^$/d') <(printf '%s\n' "$backed_up" | sed '/^$/d'))"
fi
if [[ -n "$NEWER" ]]; then
  count="$(wc -l <<<"$NEWER" | tr -d ' ')"
  case "$NEWER_KEYS" in
    refuse)
      while IFS= read -r key; do printf '  %s\n' "$key" >&2; done <<<"$NEWER"
      die "the target holds $count managed data key(s) the backup does not contain (listed above): restoring would destroy the only copy of each and leave what they sealed unreadable. Re-run with --keep-newer-keys (carried over as DECRYPT_ONLY) or, only if the blobs are restored from before those keys were activated, --discard-newer-keys — RUNBOOK §7"
      ;;
    keep)
      [[ -z "$JOBS" ]] || die "--keep-newer-keys needs the single-transaction restore (omit --jobs)"
      archive_has_key_table ||
        die "the backup has no EncryptionKey table (older than phase 7): --keep-newer-keys cannot carry the keys over. Export them first (pg_dump --data-only -t '\"EncryptionKey\"'), re-run with --discard-newer-keys, then after the migrations re-insert them as DECRYPT_ONLY and record the documents under them before the API starts (RUNBOOK §7)"
      log "carrying over $count managed data key(s) absent from the backup, as DECRYPT_ONLY: $(tr '\n' ' ' <<<"$NEWER")"
      ;;
    discard)
      log "WARNING: dropping $count managed data key(s) absent from the backup (--discard-newer-keys): $(tr '\n' ' ' <<<"$NEWER")"
      ;;
  esac
fi

started="$(now_ms)"
# 4. Optional creation of the target database (through the maintenance database).
if $CREATE; then
  exists="$(PGDATABASE="${RESTORE_ADMIN_DB:-postgres}" psql -X -At -v ON_ERROR_STOP=1 \
    -c "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")"
  [[ -z "$exists" ]] || die "database $TARGET_DB already exists (omit --create to restore over it)"
  PGDATABASE="${RESTORE_ADMIN_DB:-postgres}" psql -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\""
  log "created database $TARGET_DB"
fi

# 5. Restore. Ownership and grants are not restored: objects belong to the connecting role.
# Over an existing database, `pg_restore --clean` would drop only the objects the archive contains,
# without CASCADE: tables added by a later migration (foreign keys to restored tables) make it
# abort — the usual case when rolling back a bad release. The target schema is dropped with
# everything in it and recreated instead; the archive's own CREATE SCHEMA entry is skipped.
# The grants on the schema itself (e.g. USAGE for the API's runtime role) are carried over.
args=(--no-owner --no-privileges --exit-on-error)
if ! $CREATE; then
  cat >"$WORK/reset.sql" <<'SQL'
CREATE TEMP TABLE dfn_schema_grants AS
  SELECT format('GRANT %s ON SCHEMA %I TO %s', a.privilege_type, n.nspname,
    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END) AS stmt
  FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
  WHERE n.nspname = :'schema' AND a.grantee <> n.nspowner;
SQL
  if [[ -n "$NEWER" && "$NEWER_KEYS" == keep ]]; then
    # Saved in a temporary table (pg_temp survives the schema drop), re-inserted after the restore.
    cat >>"$WORK/reset.sql" <<'SQL'
CREATE TEMP TABLE dfn_kept_keys AS
  SELECT * FROM :"schema"."EncryptionKey" WHERE status IN ('ACTIVE', 'DECRYPT_ONLY');
SQL
    cat >"$WORK/post.sql" <<'SQL'
CREATE TEMP TABLE dfn_newer_keys AS
  SELECT k.* FROM dfn_kept_keys k
  WHERE NOT EXISTS (SELECT 1 FROM :"schema"."EncryptionKey" r
                    WHERE r.purpose = k.purpose AND r."keyId" = k."keyId");
-- Values in the database came back with the keys that sealed them; blobs did not: any of them may
-- have been re-sealed since the backup with a carried-over documents key. Every restored document
-- that still has a blob is recorded under the newest such key, which makes it pending: the key
-- rotation re-opens each blob (the row is repaired, the blob re-sealed with the active key) and
-- the retire check counts it against every carried-over key until it has been processed.
UPDATE :"schema"."Document" d SET "encryptionKeyId" = n."keyId"
FROM (SELECT "keyId" FROM dfn_newer_keys WHERE purpose = 'documents'
      ORDER BY "createdAt" DESC LIMIT 1) n
WHERE d.encrypted AND d."blobPurgedAt" IS NULL AND d."encryptionKeyId" IS DISTINCT FROM n."keyId";
INSERT INTO :"schema"."EncryptionKey" (id, purpose, "keyId", status, "wrappedKey", "kmsProvider",
  "kmsKeyRef", "activateAfter", "activatedAt", "deactivatedAt", "retiredAt", "createdByUserId",
  "createdAt", "updatedAt")
SELECT k.id, k.purpose, k."keyId", 'DECRYPT_ONLY', k."wrappedKey", k."kmsProvider", k."kmsKeyRef",
  k."activateAfter", k."activatedAt", COALESCE(k."deactivatedAt", now()), NULL, k."createdByUserId",
  k."createdAt", now()
FROM dfn_newer_keys k;
SQL
  fi
  cat >>"$WORK/reset.sql" <<'SQL'
DROP SCHEMA IF EXISTS :"schema" CASCADE;
CREATE SCHEMA :"schema";
SELECT stmt FROM dfn_schema_grants \gexec
SQL
  pg_restore --list "$ARCHIVE" | grep -vE "^[0-9]+; [0-9]+ [0-9]+ SCHEMA - \"?${DFN_PG_SCHEMA}\"? " \
    >"$WORK/toc.list"
  args+=(--use-list="$WORK/toc.list")
fi
log "restoring $(basename "$FILE") into ${PGHOST}:${PGPORT}/${TARGET_DB}"
if [[ -n "$JOBS" ]]; then
  $CREATE || psql -X -q -v ON_ERROR_STOP=1 -v schema="$DFN_PG_SCHEMA" --single-transaction -f "$WORK/reset.sql" >/dev/null
  pg_restore "${args[@]}" --jobs="$JOBS" --dbname="$TARGET_DB" "$ARCHIVE"
elif $CREATE; then
  pg_restore "${args[@]}" --single-transaction --dbname="$TARGET_DB" "$ARCHIVE"
else
  # One transaction for the schema reset and the restore: any error leaves the database as it was.
  # The script is written out first (private work dir): a pipe would let psql commit a truncated
  # script if pg_restore failed half way.
  pg_restore "${args[@]}" --file="$WORK/restore.sql" "$ARCHIVE"
  post=()
  [[ -f "$WORK/post.sql" ]] && post=(-f "$WORK/post.sql")
  psql -X -q -v ON_ERROR_STOP=1 -v schema="$DFN_PG_SCHEMA" --single-transaction \
    -f "$WORK/reset.sql" -f "$WORK/restore.sql" "${post[@]}" >/dev/null
fi
log "restore completed in $(elapsed "$started") s"
if [[ -n "$NEWER" && "$NEWER_KEYS" == keep ]]; then
  log "kept keys are DECRYPT_ONLY; with a documents key among them, every document with a blob is recorded under it: ENCRYPTION_KEY_ROTATION re-opens them all (\"À re-chiffrer\" in /admin/keys) before any of these keys can be retired (RUNBOOK §7)"
fi
log "next: restore the blobs of the same date, prisma migrate status, row counts and ledger reconciliation (RUNBOOK §7, infra/ops/restore-test.sh)"
