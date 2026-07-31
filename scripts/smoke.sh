#!/usr/bin/env bash
# Quick end-to-end sanity check against a running stack (not the load test — that's k6, later).
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
METRICS_BASE="${METRICS_BASE:-http://localhost:9464}"   # /metrics is on its own port (§S8)
# Load the admin key from .env (gitignored) if present, else require it in the environment —
# so no credential is committed to the repo (§S2).
[ -f .env ] && { set -a; . ./.env; set +a; }
KEY="${IOC_ADMIN_API_KEY:?set IOC_ADMIN_API_KEY (in .env or the environment)}"
ct='content-type: application/json'

say() { printf '\n== %s ==\n' "$1"; }

say "healthz (liveness, process-only)"
curl -fsS "$BASE/healthz"; echo

say "readyz (PG hard-dep; cache reported)"
curl -fsS "$BASE/readyz"; echo

say "lookup seeded malicious IP -> malicious"
curl -fsS -XPOST "$BASE/lookup" -H "$ct" -d '{"type":"ip","value":"203.0.113.7"}'; echo

say "lookup unknown IP -> unknown (negative-cached)"
curl -fsS -XPOST "$BASE/lookup" -H "$ct" -d '{"type":"ip","value":"8.8.8.8"}'; echo

say "upsert domain (authed) — note mixed case in"
curl -fsS -XPOST "$BASE/ioc" -H "x-api-key: $KEY" -H "$ct" \
  -d '{"type":"domain","value":"Evil.COM","source":"smoke","score":80}'; echo

say "lookup the upserted domain by lowercase -> malicious (normalization works)"
curl -fsS -XPOST "$BASE/lookup" -H "$ct" -d '{"type":"domain","value":"evil.com"}'; echo

say "IPv6 equivalence: upsert ::1 then look up its long form -> malicious"
curl -fsS -XPOST "$BASE/ioc" -H "x-api-key: $KEY" -H "$ct" \
  -d '{"type":"ip","value":"::1","source":"smoke","score":50}' >/dev/null
curl -fsS -XPOST "$BASE/lookup" -H "$ct" -d '{"type":"ip","value":"0:0:0:0:0:0:0:1"}'; echo

say "upsert WITHOUT key -> 401"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -XPOST "$BASE/ioc" -H "$ct" \
  -d '{"type":"ip","value":"1.2.3.4","source":"x","score":1}'

say "invalid sha256 -> 400"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -XPOST "$BASE/lookup" -H "$ct" \
  -d '{"type":"sha256","value":"deadbeef"}'

say "metrics (separate port $METRICS_BASE; note NO ioc value labels)"
curl -fsS "$METRICS_BASE/metrics" | grep -E '^iocheck_|^http_requests_total' | head -8
say "public port must NOT serve /metrics (should be 404)"
curl -s -o /dev/null -w '  GET :3000/metrics -> %{http_code} (expect 404)\n' "$BASE/metrics"

echo; echo "smoke complete."
