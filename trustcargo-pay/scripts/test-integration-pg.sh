#!/usr/bin/env bash
# Runs the integration suite (tests/integration) against PostgreSQL 16 with the Supabase migrations.
#
# Builds a template database (Supabase shim + migrations); every test app then gets its own empty,
# migrated database cloned from it (tests/integration/pg-test-db.ts) and connects as service_role.
#
#   DATABASE_URL set   -> uses that server (superuser, e.g. a CI postgres service); the template and
#                         the per-test databases are created next to the DATABASE_URL database.
#   DATABASE_URL unset -> starts a temporary local cluster in .tmp/pgdata-integration (port 54329,
#                         unix socket, trust auth) and removes it afterwards.
# Extra arguments are passed to vitest (e.g. a file filter).
set -euo pipefail

LOG_PREFIX=test-pg
# shellcheck source=lib/pg-cluster.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/pg-cluster.sh"

TEMPLATE_DB="trustcargo_template"

pg_cluster_start pgdata-integration
pg_admin_sql "do \$\$ begin
    if exists (select 1 from pg_database where datname = '$TEMPLATE_DB') then
        execute 'alter database $TEMPLATE_DB is_template false';
    end if;
end \$\$"
pg_admin_sql "drop database if exists $TEMPLATE_DB with (force)"
pg_admin_sql "create database $TEMPLATE_DB"
pg_apply_schema "$(pg_url_for "$TEMPLATE_DB")"
# Nobody may stay connected to a template while it is being cloned.
pg_admin_sql "alter database $TEMPLATE_DB with allow_connections false is_template true"

log "running vitest on tests/integration"
status=0
TEST_PG_ADMIN_URL="$SERVER_URL" TEST_PG_TEMPLATE_DB="$TEMPLATE_DB" \
    "$ROOT/node_modules/.bin/vitest" run --root "$ROOT" tests/integration "$@" || status=$?

if [[ -n "${DATABASE_URL:-}" ]]; then
    pg_admin_sql "alter database $TEMPLATE_DB with is_template false" || true
    pg_admin_sql "drop database if exists $TEMPLATE_DB" || true
fi
exit "$status"
