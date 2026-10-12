#!/usr/bin/env bash
# Restore a PostgreSQL backup produced by backup.sh into a target database.
# SANDBOX ONLY — fictitious data. Restoring REPLACES the objects of the target database: the script
# asks for confirmation (type the database name) unless --yes is given.
#
# Usage: infra/ops/restore.sh <backup.dump[.age|.gpg]> [--target-url URL] [--create] [--jobs N] [--yes]
#
#   --target-url URL  target database (default: RESTORE_DATABASE_URL, then DATABASE_URL)
#   --create          create the target database first (it must not exist); otherwise the target
#                     must exist and its schema (?schema=, default public) is dropped with
#                     everything in it, then restored — in the same transaction unless --jobs
#   --jobs N          parallel restore (faster, NOT atomic); default is a single transaction
#   --yes             skip the interactive confirmation (required when stdin is not a terminal)
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-url) TARGET_URL="$2"; shift 2 ;;
    --create) CREATE=true; shift ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --yes | -y) YES=true; shift ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
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
  psql -X -q -v ON_ERROR_STOP=1 -v schema="$DFN_PG_SCHEMA" --single-transaction \
    -f "$WORK/reset.sql" -f "$WORK/restore.sql" >/dev/null
fi
log "restore completed in $(elapsed "$started") s"
log "next: prisma migrate status, row counts and ledger reconciliation (see infra/ops/restore-test.sh)"
