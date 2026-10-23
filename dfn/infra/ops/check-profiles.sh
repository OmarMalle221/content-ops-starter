#!/usr/bin/env bash
# End-to-end check of the optional compose profiles, against a running stack.
# SANDBOX ONLY — creates one fictitious user and one fictitious document.
#
# Usage: infra/ops/check-profiles.sh [--api URL] [--prometheus URL] [--grafana URL] [--origin ORIGIN]
#
#   --api URL         API base URL (default http://127.0.0.1:4000)
#   --prometheus URL  Prometheus of the "observability" profile (default http://127.0.0.1:9090)
#   --grafana URL     Grafana of the "observability" profile (default http://127.0.0.1:3001)
#   --origin ORIGIN   browser origin accepted by the API's CSRF guard (default http://localhost:3000)
#
# Environment: GRAFANA_ADMIN_USER (default dfn-admin) and GRAFANA_ADMIN_PASSWORD (required);
# EXPECTED_ALERT_RULES (default 24).
#
# Checks: 1) a document round-trips through the API byte for byte (upload scanned, sealed, stored on
#            the configured driver — S3 (SeaweedFS) with the "s3" profile —, downloaded, opened, verified);
#         2) Prometheus scrapes every API replica (target up, bearer METRICS_TOKEN accepted), loads
#            every alert rule without evaluation error, and has scraped the upload's scan outcome;
#         3) Grafana's provisioned datasource answers and the provisioned dashboard exists, and every
#            query of that dashboard runs without error through Grafana.
set -euo pipefail
umask 077
DFN_SCRIPT=check-profiles
# shellcheck source=infra/ops/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need curl python3 openssl cmp

API="http://127.0.0.1:4000"
PROM="http://127.0.0.1:9090"
GRAFANA="http://127.0.0.1:3001"
ORIGIN="http://localhost:3000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --prometheus) PROM="$2"; shift 2 ;;
    --grafana) GRAFANA="$2"; shift 2 ;;
    --origin) ORIGIN="$2"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "${GRAFANA_ADMIN_PASSWORD:-}" ]] || die "GRAFANA_ADMIN_PASSWORD is required"
GUSER="${GRAFANA_ADMIN_USER:-dfn-admin}"
EXPECTED_RULES="${EXPECTED_ALERT_RULES:-24}"
DASHBOARDS_DIR="$DFN_ROOT/infra/observability/grafana/dashboards"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JAR="$WORK/cookies.txt"
# Credentials go through a curl config file: never on a command line (ps) nor in the logs.
printf 'user = "%s:%s"\n' "$GUSER" "$GRAFANA_ADMIN_PASSWORD" >"$WORK/grafana.curl"

# ── 1. Document round trip through the API ───────────────────────────────────
email="profiles-$(date -u +%Y%m%d%H%M%S)-$RANDOM@example.com"
password="Sandbox-$(openssl rand -hex 8)-Aa1!"
body=$(printf '{"email":"%s","password":"%s","firstName":"Profils","lastName":"Fictif","country":"SN","locale":"fr","acceptTerms":true}' "$email" "$password")
status=$(curl -s -o "$WORK/register.json" -w '%{http_code}' -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Origin: $ORIGIN" -X POST "$API/v1/auth/register" --data "$body")
[[ "$status" == 201 ]] || die "POST /v1/auth/register answered $status: $(head -c 300 "$WORK/register.json")"
printf '%%PDF-1.4\n%% check-profiles %s\n%%%%EOF\n' "$(openssl rand -hex 16)" >"$WORK/doc.pdf"
status=$(curl -s -o "$WORK/upload.json" -w '%{http_code}' -c "$JAR" -b "$JAR" -H "Origin: $ORIGIN" \
  -F "file=@$WORK/doc.pdf;type=application/pdf" -F kind=OTHER -F title=check-profiles "$API/v1/documents")
[[ "$status" == 201 ]] || die "POST /v1/documents answered $status: $(head -c 300 "$WORK/upload.json")"
doc_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$WORK/upload.json")
status=$(curl -s -o "$WORK/download.pdf" -w '%{http_code}' -b "$JAR" "$API/v1/documents/$doc_id/download")
[[ "$status" == 200 ]] || die "GET /v1/documents/:id/download answered $status"
cmp -s "$WORK/doc.pdf" "$WORK/download.pdf" || die "the downloaded document differs from the uploaded one"
log "ok   document $doc_id uploaded, stored, downloaded and verified byte for byte"

# ── 2. Prometheus ────────────────────────────────────────────────────────────
prom_json() { curl -sf --get "$PROM/api/v1/$1" "${@:2}"; }
for _ in $(seq 1 30); do
  prom_json targets >"$WORK/targets.json" &&
    python3 -c 'import json,sys; t=[x for x in json.load(open(sys.argv[1]))["data"]["activeTargets"] if x["labels"].get("job")=="dfn-api"]; sys.exit(0 if t and all(x["health"]=="up" for x in t) else 1)' "$WORK/targets.json" && break
  sleep 5
done
python3 - "$WORK/targets.json" <<'PY' || die "Prometheus does not scrape every API replica"
import json, sys
t = [x for x in json.load(open(sys.argv[1]))["data"]["activeTargets"] if x["labels"].get("job") == "dfn-api"]
for x in t:
    print(f"       target {x['scrapeUrl']} {x['health']} {x.get('lastError', '')}", file=sys.stderr)
sys.exit(0 if t and all(x["health"] == "up" for x in t) else 1)
PY
log "ok   Prometheus scrapes the API (bearer token accepted)"
prom_json rules >"$WORK/rules.json"
python3 - "$WORK/rules.json" "$EXPECTED_RULES" <<'PY' || die "alert rules are missing or fail to evaluate"
import json, sys
rules = [r for g in json.load(open(sys.argv[1]))["data"]["groups"] for r in g["rules"] if r["type"] == "alerting"]
bad = [(r["name"], r.get("lastError")) for r in rules if r.get("health") not in ("ok", "unknown")]
print(f"       {len(rules)} alert rules, unhealthy: {bad}", file=sys.stderr)
sys.exit(0 if len(rules) == int(sys.argv[2]) and not bad else 1)
PY
log "ok   Prometheus loaded $EXPECTED_RULES alert rules, none failing to evaluate"
# The upload above was scanned: its outcome reaches Prometheus at the next scrapes.
query='sum(dfn_document_scans_total{job="dfn-api", outcome="CLEAN"})'
scanned=""
for _ in $(seq 1 12); do
  scanned=$(prom_json query --data-urlencode "query=$query" |
    python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else "0")')
  [[ "${scanned%%.*}" -ge 1 ]] && break
  sleep 5
done
[[ "${scanned%%.*}" -ge 1 ]] || die "the scan outcome of the upload never reached Prometheus ($query = $scanned)"
log "ok   the upload's antivirus outcome is in Prometheus ($query = $scanned)"

# ── 3. Grafana ───────────────────────────────────────────────────────────────
health=$(curl -sf -K "$WORK/grafana.curl" "$GRAFANA/api/datasources/uid/dfn-prometheus/health") ||
  die "Grafana datasource dfn-prometheus is not provisioned or does not answer"
grep -q '"status":"OK"' <<<"$health" || die "Grafana datasource health: $health"
log "ok   Grafana datasource dfn-prometheus answers"
for file in "$DASHBOARDS_DIR"/*.json; do
  python3 - "$file" "$GRAFANA" "$WORK/grafana.curl" <<'PY' || die "dashboard $(basename "$file") is missing or one of its queries fails"
import base64, json, re, sys, time, urllib.request
dash = json.load(open(sys.argv[1])); base = sys.argv[2]
user = re.search(r'user = "(.*)"', open(sys.argv[3]).read()).group(1)
headers = {"Authorization": "Basic " + base64.b64encode(user.encode()).decode(), "Content-Type": "application/json"}
def call(path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    return json.load(urllib.request.urlopen(req, timeout=30))
call("/api/dashboards/uid/" + dash["uid"])  # provisioned (HTTP error otherwise)
now = int(time.time() * 1000); errors = []; count = 0
for panel in dash.get("panels", []):
    for target in panel.get("targets", []):
        if "expr" not in target:
            continue
        count += 1
        res = call("/api/ds/query", {"from": str(now - 900_000), "to": str(now), "queries": [{
            "refId": "A", "datasource": {"uid": "dfn-prometheus", "type": "prometheus"},
            "expr": target["expr"], "range": True, "intervalMs": 15000, "maxDataPoints": 100}]})["results"]["A"]
        if res.get("error"):
            errors.append((panel.get("title"), res["error"][:200]))
print(f"       {dash['title']}: {count} queries, errors: {errors}", file=sys.stderr)
sys.exit(1 if errors or count == 0 else 0)
PY
done
log "ok   Grafana dashboards provisioned, every query runs"
log "PROFILES CHECK PASSED"
