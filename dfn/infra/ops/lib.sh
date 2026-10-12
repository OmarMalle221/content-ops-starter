# shellcheck shell=bash
# Shared helpers for the DFN ops scripts (backup.sh, restore.sh, restore-test.sh, smoke-api.sh).
# SANDBOX ONLY — these scripts handle fictitious data; they never print secrets.
#
# Sourced, not executed. Callers must `set -euo pipefail` themselves.

# Used by the scripts that source this file.
# shellcheck disable=SC2034
DFN_OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034
DFN_ROOT="$(cd "$DFN_OPS_DIR/../.." && pwd)"

log() { printf '[%s] %s\n' "${DFN_SCRIPT:-dfn-ops}" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

need() {
  local bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null 2>&1 || die "required command not found: $bin"
  done
}

# Replaces the password of a connection URL with ***, so URLs can be logged safely.
redact_url() {
  printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'
}

# Percent-decodes a URL component. `+` stays literal (userinfo and path, as libpq and Prisma read
# them) and a backslash is data, never an escape: only %XX sequences are decoded.
urldecode() {
  local s="$1" out="" hex
  while [[ "$s" == *%* ]]; do
    out+="${s%%\%*}"
    s="${s#*%}"
    hex="${s:0:2}"
    if [[ "$hex" =~ ^[0-9A-Fa-f]{2}$ ]]; then
      # shellcheck disable=SC2059 # the format is a single \xHH escape built from two hex digits
      out+="$(printf "\\x$hex")"
      s="${s:2}"
    else
      out+="%"
    fi
  done
  printf '%s' "$out$s"
}

# parse_pg_url URL — exports libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE,
# PGSSLMODE) from a postgres:// or postgresql:// URL, so credentials never appear in argv (ps).
# Prisma-only query parameters (schema, connection_limit, …) are ignored; sslmode is honoured.
parse_pg_url() {
  local url="$1" rest query="" creds="" hostpart user pass="" hostport db host port param
  case "$url" in
    postgresql://* | postgres://*) ;;
    *) die "not a postgres URL: $(redact_url "$url")" ;;
  esac
  rest="${url#*://}"
  if [[ "$rest" == *\?* ]]; then
    query="${rest#*\?}"
    rest="${rest%%\?*}"
  fi
  hostpart="$rest"
  if [[ "$rest" == *@* ]]; then
    creds="${rest%@*}"
    hostpart="${rest##*@}"
  fi
  user="${creds%%:*}"
  [[ "$creds" == *:* ]] && pass="${creds#*:}"
  hostport="${hostpart%%/*}"
  db=""
  [[ "$hostpart" == */* ]] && db="${hostpart#*/}"
  host="${hostport%:*}"
  port="5432"
  if [[ "$hostport" == *:* ]]; then port="${hostport##*:}"; fi
  [[ -n "$host" ]] || host="localhost"
  [[ -n "$db" ]] || die "database name missing in $(redact_url "$url")"

  export PGHOST="$host" PGPORT="$port" PGDATABASE
  PGDATABASE="$(urldecode "$db")"
  if [[ -n "$user" ]]; then
    export PGUSER
    PGUSER="$(urldecode "$user")"
  else
    unset PGUSER
  fi
  if [[ -n "$pass" ]]; then
    export PGPASSWORD
    PGPASSWORD="$(urldecode "$pass")"
  else
    unset PGPASSWORD
  fi
  unset PGSSLMODE
  DFN_PG_SCHEMA="public"
  if [[ -n "$query" ]]; then
    local IFS='&'
    for param in $query; do
      case "$param" in
        sslmode=*) export PGSSLMODE="${param#sslmode=}" ;;
        schema=*) DFN_PG_SCHEMA="$(urldecode "${param#schema=}")" ;;
      esac
    done
  fi
  export DFN_PG_SCHEMA
}

# url_with_database URL NAME — same URL (credentials, host, query) pointing at another database.
url_with_database() {
  local url="$1" name="$2" base query=""
  base="${url%%\?*}"
  [[ "$url" == *\?* ]] && query="?${url#*\?}"
  printf '%s/%s%s' "${base%/*}" "$name" "$query"
}

# Only plain identifiers are accepted for databases this tooling creates or drops.
assert_safe_db_name() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "unsafe database name '$1' (expected [a-z_][a-z0-9_]*)"
}

# Seconds since epoch with millisecond precision, for timing reports.
now_ms() { date +%s%3N; }
elapsed() { awk -v s="$1" -v e="$(now_ms)" 'BEGIN { printf "%.1f", (e - s) / 1000 }'; }
