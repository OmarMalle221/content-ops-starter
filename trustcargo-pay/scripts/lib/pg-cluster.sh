# Shared PostgreSQL bootstrap for scripts/test-db.sh and scripts/test-integration-pg.sh (sourced, not run).
#
#   DATABASE_URL set   -> uses that server (superuser required: the shim creates roles; CI postgres service).
#   DATABASE_URL unset -> starts a temporary local cluster in .tmp/<name> (port $PGTEST_PORT or 54329,
#                         unix socket in the data dir, trust auth, run as the `postgres` system user when
#                         root) and removes it on exit.
#
# After `pg_cluster_start <data-dir-name>`:
#   PSQL_BIN            psql binary
#   SERVER_URL          postgres:// URL of the server's maintenance database (or DATABASE_URL)
#   pg_url_for DB       prints the URL of database DB on the same server (psql and Node accept it)
#   pg_admin_sql SQL    runs SQL on the maintenance database
#   pg_apply_schema URL applies the Supabase shim and the migrations
# The caller sets LOG_PREFIX before sourcing.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUPABASE_DIR="$ROOT/supabase"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGTEST_PORT:-54329}"

if command -v psql >/dev/null 2>&1; then PSQL_BIN="$(command -v psql)"; else PSQL_BIN="$PG_BIN/psql"; fi

log() { printf '[%s] %s\n' "${LOG_PREFIX:-pg}" "$*" >&2; }

CLUSTER_STARTED=0
DATA_DIR=""
SOCK_DIR=""
EXTRA_SOCK_DIR=""
RUN_AS=()
SERVER_URL=""

pg_cluster_cleanup() {
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

pg_cluster_start() {
    local name="$1"
    trap pg_cluster_cleanup EXIT INT TERM
    if [[ -n "${DATABASE_URL:-}" ]]; then
        log "using DATABASE_URL"
        SERVER_URL="$DATABASE_URL"
        return
    fi
    [[ -x "$PG_BIN/initdb" ]] || { log "initdb not found in $PG_BIN (set PG_BIN)"; exit 1; }
    DATA_DIR="$ROOT/.tmp/$name"
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
        -o "-p $PORT -k $SOCK_DIR -c listen_addresses='' -c fsync=off -c max_connections=200" start >/dev/null
    SERVER_URL="postgresql://postgres@localhost/postgres?host=$SOCK_DIR&port=$PORT"
}

# postgres:// URL of database $1 on the same server (only the path changes; credentials/options are kept).
pg_url_for() {
    node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString());' "$SERVER_URL" "$1"
}

pg_admin_sql() {
    PGOPTIONS="-c client_min_messages=warning" "$PSQL_BIN" -X -q "$SERVER_URL" -v ON_ERROR_STOP=1 -c "$1"
}

# Applies the Supabase shim then every migration (filename = timestamp order) to the database at URL $1.
pg_apply_schema() {
    pg_run_sql_file "$1" "$SUPABASE_DIR/tests/supabase_shim.sql"
    shopt -s nullglob
    local migrations=("$SUPABASE_DIR"/migrations/*.sql)
    [[ ${#migrations[@]} -gt 0 ]] || { log "no migrations found"; exit 1; }
    local f
    for f in "${migrations[@]}"; do
        pg_run_sql_file "$1" "$f"
    done
}

pg_run_sql_file() {
    log "applying $(basename "$2")"
    PGOPTIONS="-c client_min_messages=warning" "$PSQL_BIN" -X -q "$1" -v ON_ERROR_STOP=1 --single-transaction -f "$2" >/dev/null
}
