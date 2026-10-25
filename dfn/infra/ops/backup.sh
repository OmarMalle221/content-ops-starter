#!/usr/bin/env bash
# PostgreSQL backup — pg_dump custom format, optional encryption, checksum, retention pruning.
# SANDBOX ONLY: the data is fictitious, but backups still hold personal data of test users and are
# handled as sensitive (umask 077, encryption recommended, never stored next to the keys).
#
# Usage: infra/ops/backup.sh [--dir DIR] [--retention-days N] [--keep-min N] [--label LABEL] [--no-prune]
#
# Environment
#   BACKUP_DATABASE_URL or DATABASE_URL   source database (postgres URL; Prisma ?schema= is ignored)
#   BACKUP_DIR                 output directory (default: ./backups)
#   BACKUP_RETENTION_DAYS      prune backups of this database older than N days (default: 30)
#   BACKUP_KEEP_MIN            always keep the N most recent backups, whatever their age (default: 7)
#   BACKUP_AGE_RECIPIENT       encrypt with age for this public key (age1…), or
#   BACKUP_AGE_RECIPIENTS_FILE encrypt with age for every recipient listed in this file, or
#   BACKUP_GPG_RECIPIENT       encrypt with gpg for this key (use the full fingerprint)
#   BACKUP_AGE_IDENTITY_FILE   optional: lets the script verify an age-encrypted archive it just wrote
#
# Output: DIR/dfn-<db>[-<label>]-<UTC timestamp>.dump[.age|.gpg] and a .sha256 file next to it.
# The path of the backup is the only line written to stdout (logs go to stderr).
set -euo pipefail
umask 077
DFN_SCRIPT=backup
# shellcheck source=infra/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
KEEP_MIN="${BACKUP_KEEP_MIN:-7}"
LABEL=""
PRUNE=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --retention-days) RETENTION_DAYS="$2"; shift 2 ;;
    --keep-min) KEEP_MIN="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --no-prune) PRUNE=false; shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "--retention-days must be an integer"
[[ "$KEEP_MIN" =~ ^[0-9]+$ ]] || die "--keep-min must be an integer"
[[ -z "$LABEL" || "$LABEL" =~ ^[a-z0-9_-]{1,32}$ ]] || die "--label must match [a-z0-9_-]{1,32}"

SOURCE_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
[[ -n "$SOURCE_URL" ]] || die "BACKUP_DATABASE_URL or DATABASE_URL is required"
need pg_dump pg_restore sha256sum
parse_pg_url "$SOURCE_URL"

ENCRYPTION="none"
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" || -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]]; then
  need age
  ENCRYPTION="age"
elif [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
  need gpg
  ENCRYPTION="gpg"
fi

mkdir -p "$DIR"
DIR="$(cd "$DIR" && pwd)"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
name="dfn-${PGDATABASE}${LABEL:+-$LABEL}-${ts}.dump"
case "$ENCRYPTION" in
  age) name="$name.age" ;;
  gpg) name="$name.gpg" ;;
esac
final="$DIR/$name"
partial="$DIR/.$name.partial"
[[ ! -e "$final" ]] || die "backup already exists: $final"

cleanup() { rm -f "$partial"; }
trap cleanup EXIT

log "dumping ${PGHOST}:${PGPORT}/${PGDATABASE} (encryption: $ENCRYPTION)"
started="$(now_ms)"
dump() {
  pg_dump --format=custom --compress=6 --no-password --lock-wait-timeout=60s --dbname="$PGDATABASE"
}
case "$ENCRYPTION" in
  age)
    if [[ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]]; then
      dump | age --encrypt --recipients-file "$BACKUP_AGE_RECIPIENTS_FILE" --output "$partial"
    else
      dump | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$partial"
    fi
    ;;
  gpg)
    # The recipient is pinned explicitly by the operator (fingerprint), hence trust-model always.
    dump | gpg --batch --quiet --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$partial"
    ;;
  none)
    dump >"$partial"
    ;;
esac

# Verify that the archive is a readable pg_dump archive (table of contents) before publishing it.
case "$ENCRYPTION" in
  none)
    pg_restore --list "$partial" >/dev/null || die "pg_restore cannot read the archive just written"
    log "archive verified (pg_restore --list)"
    ;;
  age)
    if [[ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]]; then
      age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" "$partial" | pg_restore --list >/dev/null ||
        die "the encrypted archive cannot be decrypted/read with BACKUP_AGE_IDENTITY_FILE"
      log "archive verified (age --decrypt | pg_restore --list)"
    else
      log "encrypted archive written; set BACKUP_AGE_IDENTITY_FILE to verify it, or run restore-test.sh"
    fi
    ;;
  gpg)
    log "encrypted archive written; run restore-test.sh --dump to verify it"
    ;;
esac

mv "$partial" "$final"
(cd "$DIR" && sha256sum "$name" >"$name.sha256")
size="$(du -h "$final" | cut -f1)"
log "backup written: $final ($size, $(elapsed "$started") s)"

if $PRUNE; then
  cutoff=$(($(date +%s) - RETENTION_DAYS * 86400))
  index=0
  pruned=0
  # Newest first; only this database's backups; the KEEP_MIN most recent are always kept.
  while IFS= read -r line; do
    mtime="${line%% *}"
    file="${line#* }"
    index=$((index + 1))
    if ((index > KEEP_MIN)) && ((${mtime%.*} < cutoff)); then
      rm -f -- "$file" "$file.sha256"
      pruned=$((pruned + 1))
      log "pruned $(basename "$file")"
    fi
  done < <(find "$DIR" -maxdepth 1 -type f \
    \( -name "dfn-${PGDATABASE}-*.dump" -o -name "dfn-${PGDATABASE}-*.dump.age" -o -name "dfn-${PGDATABASE}-*.dump.gpg" \) \
    -printf '%T@ %p\n' | sort -rn)
  log "retention: ${RETENTION_DAYS} days, keep at least ${KEEP_MIN}; pruned ${pruned} backup(s)"
fi

printf '%s\n' "$final"
