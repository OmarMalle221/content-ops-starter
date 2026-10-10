#!/usr/bin/env bash
# Applies the Supabase migrations to a throwaway PostgreSQL 16 database (with a minimal Supabase
# shim) and runs the self-checking RLS / ledger test script.
#
#   DATABASE_URL set   -> uses that database (must be EMPTY, e.g. a CI postgres service).
#   DATABASE_URL unset -> starts a temporary local cluster in .tmp/pgdata (port 54329, unix socket
#                         in the data dir, trust auth) and removes it afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGTEST_PORT:-54329}"
DB_NAME="trustcargo_test"

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
    DATA_DIR="$ROOT/.tmp/pgdata"
    rm -rf "$DATA_DIR"
    mkdir -p "$DATA_DIR"
    SOCK_DIR="$DATA_DIR"
    # Unix socket paths are limited to 107 bytes: fall back to a short temp dir for deep checkouts.
    if (( ${#DATA_DIR} + 16 > 100 )); then
        EXTRA_SOCK_DIR="$(mktemp -d /tmp/tcp-pgsock.XXXXXX)"
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

log "running rls_test.sql"
"$PSQL_BIN" -X -q "${CONN[@]}" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/tests/rls_test.sql"
log "OK"
