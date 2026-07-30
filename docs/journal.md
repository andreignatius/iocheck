# iocheck — Build Journal

Dated record of progress, checked against [`plan.md`](./plan.md). Legend: `[x]` done · `[~]` in progress · `[ ]` not started.
(The **plan** = design; the **transcript** = AI chat log; this **journal** = what actually got built, when.)

---

## Status vs plan build sequence (§9)

- [x] **M1 — Service** (Express + zod + metrics + read-through cache + auth + graceful shutdown) — *2026-07-30*
- [ ] **M2 — Containerize** (Dockerfile, docker-compose: service + pg + redis)
- [ ] **M3 — Cluster** (multi-node kind + Calico/Cilium; manifests: Deployment/Service/PDB/probes/limits + securityContext + Secrets + NetworkPolicy)
- [ ] **M4 — Observability** (Prometheus scrape + Grafana dashboards + metrics-server + KEDA)
- [ ] **M5 — Baseline evidence** (CPU-HPA + k6 spike → "CPU flat, no scale, p99 blows past 200ms" → challenge #1)
- [ ] **M6 — Real autoscaler** (KEDA RPS/pod, empirical target, up-fast/down-slow + fallback → demo 2→N→2 → challenges #3/#4)
- [ ] **M7 — Load-sharing** (even per-pod distribution; keep-alive → challenge #2)
- [ ] **M8 — Resilience / chaos** (kill pod + kill Redis under load → drain §O2 + fail-open §O3)
- [ ] **M9 — Wrap** (writeup, README, Makefile polish, transcript cleanup)

## Status vs deliverables (§8)

- [~] Source + manifests + Dockerfile + Makefile — *source done; manifests/Dockerfile/Makefile pending (M2/M3)*
- [ ] README (reproduces setup from clean state)
- [ ] Load-test tool (k6 script)
- [ ] Writeup (~1–2pp: architecture + 4 answers + data-source-down + one-week + security posture)
- [x] AI chat logs — `docs/transcript.md` (recording, verbatim + timestamps)

## Four challenges (§7)

- [ ] #1 Why CPU HPA is wrong (measured evidence) — needs M5
- [ ] #2 Pods share load (keep-alive trap) — needs M7
- [ ] #3 Autoscaler up & down, defend min/max — needs M6
- [ ] #4 Reproducible test — needs M6 + load tool

---

## Log

### 2026-07-30 — Planning (M0)
- Locked stack: Express + zod + prom-client · Postgres + Redis (read-through) · Docker + kind · Prometheus + Grafana · KEDA (Prometheus scaler, RPS/pod) · k6. (transcript T1–T3)
- Wrote `plan.md`: architecture, autoscaling thesis (why CPU fails → RPS signal → empirical target → KEDA shape), data model. (T3)
- Added defend-min/max method + downstream Postgres-connection ceiling + Bloom-filter future work. (T4–T5)
- Added **§S Security-by-design** (S1–S10: auth, secrets, per-type validation, container/pod hardening, NetworkPolicy + kind-CNI caveat, integrity, audit, metrics-leakage, rate-limit, supply chain). (T6–T7)
- Added **§O Operational readiness** (O1–O9: windowed SLO + TTR, graceful shutdown, Redis-SPOF/hard-soft deps, PDB deadlock → min=3, topology spread, golden signals, CPU-throttling, connection math, chaos). (T9)
- Sanity sweep: fixed preStop-vs-SIGTERM ordering; reconciled min=2→3 across doc; added deliberate-deviation heads-up (brief "return to 2" vs our floor 3). (T10)

### 2026-07-30 16:03 — Milestone 1: Service ✅
**Built** the full Express service and verified it. Files:
- Scaffold: `package.json`, `tsconfig.json` (strict, CommonJS), `.gitignore` (ignores `.env`), `.env` + `.env.example`, `db/init.sh` (schema PK(type,value) + least-priv `iocheck_app` role from env §S2 + seed; *was init.sql, changed in review*).
- `src/config.ts` — zod-validated env, fails fast, no secret values in errors.
- `src/logger.ts` — pino, redacts api-key/authorization/password (§S7).
- `src/metrics.ts` — RPS + latency histogram (buckets under 200ms) + in-flight + lookup-results (**type/verdict only, no value label §S8**) + cache events + `cache_up`.
- `src/validation.ts` — per-type validation (`net.isIP`, domain regex, sha256 64-hex) + `.strict()` + max 512 + **normalizeValue** anti-evasion (§S3).
- `src/db.ts` — pg Pool (hard dep §O3) + `pingDb` + fail-fast conn timeout.
- `src/cache.ts` — redis **fail-open** (swallow errors, `cache_up=0`), tight timeouts (§O3).
- `src/repository.ts` — parameterized SQL + idempotent `ON CONFLICT` upsert.
- `src/service.ts` — read-through + **negative caching** + fail-open-to-DB; upsert invalidates.
- `src/auth.ts` — API-key middleware for `/ioc`, constant-time compare (§S1).
- `src/state.ts` + `src/app.ts` + `src/index.ts` — 5 endpoints (liveness process-only; **readyz = PG hard / Redis soft** §O3), metrics mw, generic error handler (no stack leak §S10), **graceful shutdown drain** (§O2).
- `src/validation.test.ts` — 13 tests.

**Verification:** local Node was v14/v16 (too old) → installed Node 20 via nvm. `tsc --noEmit` clean; `vitest run` → **13/13 pass**.

**Deferred / notes:**
- Not yet run end-to-end (needs Postgres+Redis → M2).
- **Cache-stampede / singleflight** (§O3) not yet implemented — slot in before the load test (M7/pre-M5).
- Dev/build requires **Node ≥18** (verified on 20).

### 2026-07-30 16:20 — Design revision: min replicas 3 → **ship 2**, prod-floor 3
- Andre re-read the walkthrough ("show it return to **2**") and challenged the min=3 decision.
- **Verified mechanism:** PDBs are honored only by the **eviction API** → node drains / cluster-autoscaler
  are gated (deadlock at min==minAvailable); **HPA scale-down and rolling updates delete pods directly,
  NOT via eviction**, so they work fine at min=2. Corrected an imprecision in §O4 (it had said rolling
  updates "stall" — they don't).
- **Decision:** **ship min=2** (matches walkthrough + spec `minAvailable>=2`; demo shows 2→N→2); keep
  **min=3 as documented prod hardening** + the **challenge-#3 "defend your min"** talking point. Annotate
  the PDB/Deployment manifests loudly so min==minAvailable reads as intentional, not the classic mistake.
- **Plan updated:** §4c (minReplicaCount 3→2 + note), §4d (min=2 shipped + reframed heads-up), §O4
  (eviction-API mechanism table + ship-2/prod-3), §5 checklist, §7 challenges #3/#4, build seq M6,
  Locked-decisions line. Consistency-swept (only prod-guidance 3s remain).

### 2026-07-30 16:52 — M1 code review (Andre) → 7 fixes
Andre reviewed M1 and raised 5 concerns (all valid); Claude found 2 more. All fixed + verified (typecheck clean, **15/15 tests**):
1. **Committed secret** — `db/init.sql` hardcoded the app-role password. Replaced with **`db/init.sh`** that creates the least-priv role from `APP_DB_PASSWORD` (env, via `\gexec` + `format(%I,%L)`) — nothing secret committed (§S2). Added `APP_DB_*` to `.env`/`.env.example`.
2. **IPv6 non-canonicalization** — `::1` vs `0:0:0:0:0:0:0:1` stored as different rows/keys. Added **`ipaddr.js`**; `normalizeValue('ip')` now returns RFC-5952 canonical form → equivalent spellings collapse to one (anti-evasion §S3). +2 tests.
3. **Redis fail-open slow** — added **`disableOfflineQueue: true`** (commands fail fast when disconnected → fall through to PG immediately) + a **background reconnect** (node-redis doesn't auto-retry a failed *initial* connect, so degraded→healthy recovery now works).
4. **Unmatched-route cardinality** — 404s used raw `req.path` as the metric label → collapsed to a single **`unmatched`** series.
5. **`closeIdleConnections()`** — added at drain start so idle keep-alives release promptly; **`closeAllConnections()`** on the force-timeout path.
6. *(Claude)* **In-flight gauge leak** — `res.on('finish')` misses client aborts → now finalize-once on `finish` **or** `close`.
7. *(Claude)* **Oversized body → 500** — now returns **413** (`entity.too.large`) and **400** (`entity.parse.failed`) from the error handler (§S3 DoS guard).

Files touched: `db/init.sh` (new, +x), removed `db/init.sql`, `.env`/`.env.example`, `package.json` (+ipaddr.js), `src/validation.ts`, `src/cache.ts`, `src/app.ts`, `src/index.ts`, `src/validation.test.ts`.

### Open items to carry forward
- [ ] Cache-stampede protection (singleflight + jittered TTL) before load testing.
- [ ] Wire audit log on `/ioc` (§S7) — currently only pino request logging.
- [ ] Rate limiting (§S9) — deferred, decide build vs writeup.
