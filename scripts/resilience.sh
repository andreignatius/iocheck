#!/usr/bin/env bash
# M2 resilience checks: oversized-body 413 (§S3) + Redis fail-open/recovery (§O3).
# Requires the compose stack to be running (make up).
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
ct='content-type: application/json'
say() { printf '\n== %s ==\n' "$1"; }

say "oversized body (>8kb) -> expect 413"
big=$(printf 'a%.0s' $(seq 1 9000))
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -XPOST "$BASE/lookup" -H "$ct" \
  -d "{\"type\":\"domain\",\"value\":\"$big\"}"

say "FAIL-OPEN: stop Redis, lookup must still serve from Postgres"
docker compose stop redis >/dev/null 2>&1
sleep 2
echo -n "lookup seeded IP with Redis DOWN: "
curl -fsS -XPOST "$BASE/lookup" -H "$ct" -d '{"type":"ip","value":"203.0.113.7"}'; echo
echo -n "readyz with Redis DOWN (db hard=ok, cache soft=false, still 200): "
curl -s -o /dev/null -w 'HTTP %{http_code} ' "$BASE/readyz"; curl -fsS "$BASE/readyz"; echo
echo -n "cache_up gauge: "; curl -fsS "$BASE/metrics" | grep '^iocheck_cache_up'

say "RECOVER: restart Redis, background reconnect flips cache_up back to 1"
docker compose start redis >/dev/null 2>&1
sleep 4
echo -n "cache_up gauge after recovery: "; curl -fsS "$BASE/metrics" | grep '^iocheck_cache_up'
echo -n "readyz after recovery: "; curl -fsS "$BASE/readyz"; echo

echo; echo "resilience checks complete."
