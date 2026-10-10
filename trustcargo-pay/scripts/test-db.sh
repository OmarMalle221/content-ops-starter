#!/usr/bin/env bash
# Applies the Supabase migrations to a throwaway PostgreSQL 16 database (with a minimal Supabase
# shim) and runs the self-checking RLS / ledger test script.
#
#   DATABASE_URL set   -> uses that database (must be EMPTY, e.g. a CI postgres service; superuser).
#   DATABASE_URL unset -> starts a temporary local cluster in .tmp/pgdata (port 54329, unix socket
#                         in the data dir, trust auth) and removes it afterwards.
set -euo pipefail

LOG_PREFIX=test-db
# shellcheck source=lib/pg-cluster.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg-cluster.sh"

pg_cluster_start pgdata
if [[ -n "${DATABASE_URL:-}" ]]; then
    TARGET_URL="$DATABASE_URL"
else
    pg_admin_sql "create database trustcargo_test"
    TARGET_URL="$(pg_url_for trustcargo_test)"
fi

pg_apply_schema "$TARGET_URL"

log "running rls_test.sql"
"$PSQL_BIN" -X -q "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$SUPABASE_DIR/tests/rls_test.sql"
log "OK"
