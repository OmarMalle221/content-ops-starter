#!/usr/bin/env bash
# Smoke test of the API: health, register, session (/auth/me), OpenAPI document.
# SANDBOX ONLY — creates one fictitious user with a random e-mail address.
#
# Usage:
#   infra/ops/smoke-api.sh [--base-url URL] [--origin ORIGIN]
#       Checks an API that is already running (default http://127.0.0.1:${API_PORT:-4000}).
#   infra/ops/smoke-api.sh --boot [--entry apps/api/dist/main.js]
#       Starts the compiled API (environment taken from the caller), waits for /v1/health, runs the
#       checks, then sends SIGTERM and asserts a graceful exit within 30 s. Logs: $SMOKE_LOG.
set -euo pipefail
DFN_SCRIPT=smoke-api
# shellcheck source=infra/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need curl

BASE_URL=""
ORIGIN="${SMOKE_ORIGIN:-}"
BOOT=false
ENTRY="$DFN_ROOT/apps/api/dist/main.js"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --origin) ORIGIN="$2"; shift 2 ;;
    --boot) BOOT=true; shift ;;
    --entry) ENTRY="$2"; shift 2 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
BASE_URL="${BASE_URL:-http://127.0.0.1:${API_PORT:-4000}}"
# The CSRF guard only accepts browser origins listed in CORS_ORIGINS / WEB_PUBLIC_URL.
# CORS_ORIGINS may be unset (CI sets none): `set -u` needs the default before the expansion.
ORIGIN="${ORIGIN:-${CORS_ORIGINS:-}}"
ORIGIN="${ORIGIN%%,*}"
ORIGIN="${ORIGIN:-http://localhost:3000}"

WORK="$(mktemp -d)"
API_PID=""
cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then kill -KILL "$API_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if $BOOT; then
  need node
  [[ -f "$ENTRY" ]] || die "compiled entry not found: $ENTRY (run: pnpm build:api)"
  # Absolute: the boot below changes directory before starting node.
  ENTRY="$(cd "$(dirname "$ENTRY")" && pwd)/$(basename "$ENTRY")"
  SMOKE_LOG="${SMOKE_LOG:-$WORK/api.log}"
  log "booting $(basename "$ENTRY") (NODE_ENV=${NODE_ENV:-unset}, port ${API_PORT:-4000}) — logs: $SMOKE_LOG"
  (cd "$(dirname "$ENTRY")/.." && exec node --enable-source-maps "$ENTRY") >"$SMOKE_LOG" 2>&1 &
  API_PID=$!
  started="$(now_ms)"
  for _ in $(seq 1 120); do
    if curl -sf "$BASE_URL/v1/health" >/dev/null 2>&1; then break; fi
    kill -0 "$API_PID" 2>/dev/null || { tail -n 40 "$SMOKE_LOG" >&2; die "API exited during startup"; }
    sleep 0.5
  done
  curl -sf "$BASE_URL/v1/health" >/dev/null || { tail -n 40 "$SMOKE_LOG" >&2; die "API not healthy after 60 s"; }
  log "API healthy after $(elapsed "$started") s"
fi

check() {
  # check NAME EXPECTED_STATUS ACTUAL_STATUS BODY_FILE
  if [[ "$3" != "$2" ]]; then
    log "FAIL $1: HTTP $3 (expected $2)"
    head -c 600 "$4" >&2 || true
    echo >&2
    exit 1
  fi
  log "ok   $1 (HTTP $3)"
}

JAR="$WORK/cookies.txt"
status=$(curl -s -o "$WORK/health.json" -D "$WORK/health.h" -w '%{http_code}' "$BASE_URL/v1/health")
check "GET /v1/health" 200 "$status" "$WORK/health.json"
grep -q '"mode":"sandbox"' "$WORK/health.json" || die "health does not report sandbox mode"
grep -qi '^x-dfn-mode: sandbox' "$WORK/health.h" || die "x-dfn-mode: sandbox header missing"

email="smoke-$(date +%s)-$RANDOM@example.test"
password="Smoke-Sandbox-$RANDOM-2026!x"
body=$(printf '{"email":"%s","password":"%s","firstName":"Smoke","lastName":"Test","country":"CA","locale":"fr","acceptTerms":true}' "$email" "$password")
status=$(curl -s -o "$WORK/register.json" -w '%{http_code}' -c "$JAR" -b "$JAR" \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN" -X POST "$BASE_URL/v1/auth/register" --data "$body")
check "POST /v1/auth/register" 201 "$status" "$WORK/register.json"

status=$(curl -s -o "$WORK/me.json" -w '%{http_code}' -c "$JAR" -b "$JAR" "$BASE_URL/v1/auth/me")
check "GET /v1/auth/me" 200 "$status" "$WORK/me.json"
grep -q "\"email\":\"$email\"" "$WORK/me.json" || die "/v1/auth/me did not return the registered user"

status=$(curl -s -o "$WORK/docs.html" -w '%{http_code}' "$BASE_URL/docs")
check "GET /docs (OpenAPI UI)" 200 "$status" "$WORK/docs.html"

if $BOOT; then
  log "sending SIGTERM (graceful shutdown)"
  stop_started="$(now_ms)"
  kill -TERM "$API_PID"
  for _ in $(seq 1 60); do
    kill -0 "$API_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$API_PID" 2>/dev/null; then
    tail -n 40 "$SMOKE_LOG" >&2
    die "API still running 30 s after SIGTERM"
  fi
  rc=0
  wait "$API_PID" || rc=$?
  API_PID=""
  # 0 = exited after draining, 143 = Nest re-raised SIGTERM once its shutdown hooks completed.
  [[ "$rc" == 0 || "$rc" == 143 ]] || { tail -n 40 "$SMOKE_LOG" >&2; die "API exited with status $rc after SIGTERM"; }
  log "graceful shutdown in $(elapsed "$stop_started") s (exit status $rc)"
fi
log "smoke test passed against $BASE_URL"
