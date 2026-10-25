#!/usr/bin/env bash
# Applies the Supabase migrations and reference data to a throwaway PostgreSQL 16 database (with a minimal Supabase
# shim) and runs the self-checking RLS test script.
#
#   DATABASE_URL set   -> uses that database (must be EMPTY, e.g. a CI postgres service).
#   DATABASE_URL unset -> starts a temporary local cluster in .tmp/pgdata (port 54339, unix socket
#                         in the data dir, trust auth) and removes it afterwards.
#
#   --serve CMD...     -> same database setup, then runs CMD with DATABASE_URL exported instead of the
#                         tests, and stops the cluster when CMD exits (end-to-end tests: fake Supabase
#                         backed by the real schema). Uses .tmp/pgdata-serve on port 54349.
set -euo pipefail

SERVE=0
if [[ "${1:-}" == "--serve" ]]; then
    SERVE=1
    shift
    [[ $# -gt 0 ]] || { echo "usage: $0 --serve COMMAND..." >&2; exit 2; }
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
if [[ "$SERVE" == 1 ]]; then
    PORT="${PGSERVE_PORT:-54349}"
    DATA_SUBDIR="pgdata-serve"
else
    PORT="${PGTEST_PORT:-54339}"
    DATA_SUBDIR="pgdata"
fi
DB_NAME="relais_test"

if command -v psql >/dev/null 2>&1; then PSQL_BIN="$(command -v psql)"; else PSQL_BIN="$PG_BIN/psql"; fi

log() { printf '[test-db] %s\n' "$*" >&2; }

CLUSTER_STARTED=0
DATA_DIR=""
SOCK_DIR=""
EXTRA_SOCK_DIR=""
RUN_AS=()

cleanup() {
    local status=$?
    if [[ "$CLUSTER_STARTED" == 1 ]]; then
        log "stopping local cluster"
        "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
    fi
    if [[ -n "$DATA_DIR" && -d "$DATA_DIR" ]]; then
        rm -rf "$DATA_DIR"
    fi
    if [[ -n "$EXTRA_SOCK_DIR" && -d "$EXTRA_SOCK_DIR" ]]; then
        rm -rf "$EXTRA_SOCK_DIR"
    fi
    exit "$status"
}
trap cleanup EXIT INT TERM

if [[ -n "${DATABASE_URL:-}" ]]; then
    log "using DATABASE_URL"
    CONN=("$DATABASE_URL")
else
    [[ -x "$PG_BIN/initdb" ]] || { log "initdb not found in $PG_BIN (set PG_BIN)"; exit 1; }
    DATA_DIR="$ROOT/.tmp/$DATA_SUBDIR"
    # A previous run killed abruptly may have left its cluster running.
    if [[ -f "$DATA_DIR/postmaster.pid" ]]; then
        if [[ "$(id -u)" == 0 ]]; then
            runuser -u postgres -- "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
        else
            "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
        fi
    fi
    rm -rf "$DATA_DIR"
    mkdir -p "$DATA_DIR"
    SOCK_DIR="$DATA_DIR"
    # Unix socket paths are limited to 107 bytes: fall back to a short temp dir for deep checkouts.
    if (( ${#DATA_DIR} + 16 > 100 )); then
        EXTRA_SOCK_DIR="$(mktemp -d /tmp/relais-pgsock.XXXXXX)"
        SOCK_DIR="$EXTRA_SOCK_DIR"
    fi

    if [[ "$(id -u)" == 0 ]]; then
        # initdb refuses to run as root: run the cluster as the `postgres` system user.
        if ! id postgres >/dev/null 2>&1; then
            log "running as root and no 'postgres' user exists; creating it"
            useradd --system --no-create-home --shell /usr/sbin/nologin postgres
        fi
        chown -R postgres "$DATA_DIR" "$SOCK_DIR"
        chmod 700 "$DATA_DIR"
        if command -v runuser >/dev/null 2>&1; then
            RUN_AS=(runuser -u postgres --)
        else
            RUN_AS=(sudo -u postgres)
        fi
    else
        RUN_AS=(env)
    fi

    log "initdb in $DATA_DIR"
    "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$DATA_DIR" -U postgres -A trust -E UTF8 --locale=C.UTF-8 --no-sync >/dev/null
    log "starting cluster on port $PORT (socket in $SOCK_DIR)"
    CLUSTER_STARTED=1
    "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$DATA_DIR/server.log" -w \
        -o "-p $PORT -k $SOCK_DIR -c listen_addresses='' -c fsync=off" start >/dev/null
    "$PSQL_BIN" -X -q -h "$SOCK_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 \
        -c "create database $DB_NAME"
    CONN=(-h "$SOCK_DIR" -p "$PORT" -U postgres -d "$DB_NAME")
fi

run_sql() {
    log "applying $(basename "$1")"
    PGOPTIONS="-c client_min_messages=warning" "$PSQL_BIN" -X -q "${CONN[@]}" -v ON_ERROR_STOP=1 --single-transaction -f "$1" >/dev/null
}

run_sql "$SUPABASE_DIR/tests/supabase_shim.sql"
shopt -s nullglob
migrations=("$SUPABASE_DIR"/migrations/*.sql)
[[ ${#migrations[@]} -gt 0 ]] || { log "no migrations found"; exit 1; }
# Glob expansion is sorted, i.e. filename (timestamp) order.
for f in "${migrations[@]}"; do
    run_sql "$f"
done
# Reference data (consent text versions, starting resources): idempotent, applied after migrations.
for f in "$SUPABASE_DIR"/reference/*.sql; do
    run_sql "$f"
done
# Applying it twice must be a no-op.
for f in "$SUPABASE_DIR"/reference/*.sql; do
    run_sql "$f"
done

if [[ "$SERVE" == 1 ]]; then
    if [[ -z "${DATABASE_URL:-}" ]]; then
        export DATABASE_URL="postgresql://postgres@/$DB_NAME?host=$SOCK_DIR&port=$PORT"
    fi
    log "schema ready; running: $*"
    # Not exec: the EXIT trap must stop the cluster when the command ends.
    "$@" &
    CHILD=$!
    trap 'kill -TERM "$CHILD" 2>/dev/null || true' TERM INT
    wait "$CHILD" || true
    exit 0
fi

log "running rls_test.sql"
"$PSQL_BIN" -X -q "${CONN[@]}" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/tests/rls_test.sql"

# A published consent text version cannot change content: once a stored hash differs, the reference
# script must refuse to run (it would otherwise silently keep the old proof of consent).
log "checking that a changed consent text without a new version is rejected"
"$PSQL_BIN" -X -q "${CONN[@]}" -v ON_ERROR_STOP=1 \
    -c "update public.consent_texts set sha256 = repeat('0', 64) where consent_type = 'privacy_policy'" >/dev/null
if run_sql "$SUPABASE_DIR/reference/01_consent_texts.sql" 2>/dev/null; then
    log "FAIL: reference script accepted a changed consent text"
    exit 1
fi
log "OK"
