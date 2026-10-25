#!/bin/sh
# First initialisation of the compose PostgreSQL volume only (docker-entrypoint-initdb.d).
# SANDBOX ONLY. Creates the API's runtime role: data access (DML) on the Prisma schema, no DDL, not
# a superuser. Migrations keep running as POSTGRES_USER (owner of every table); the default
# privileges below grant the runtime role access to the tables those migrations create later.
# An existing volume is not touched: see docs/operations/RUNBOOK.md §2 for the one-off SQL.
set -eu
: "${POSTGRES_APP_USER:=dfn_app}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$POSTGRES_APP_USER" -v app_password="$POSTGRES_APP_PASSWORD" \
  -v owner="$POSTGRES_USER" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO :"app_user";
GRANT USAGE ON SCHEMA public TO :"app_user";
-- Not tied to a schema: they survive the schema being recreated by an in-place restore.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";
SQL
