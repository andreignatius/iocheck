# iocheck — Build Journal

Dated record of progress, checked against [`plan.md`](./plan.md). Legend: `[x]` done · `[~]` in progress · `[ ]` not started.
(The **plan** = design; the **transcript** = AI chat log; this **journal** = what actually got built, when.)

---

## Status vs plan build sequence (§9)

- [x] **M1 — Service** (Express + zod + metrics + read-through cache + auth + graceful shutdown) — *2026-07-30*
- [x] **M2 — Containerize** (Dockerfile, docker-compose: service + pg + redis) — *2026-07-30; runs end-to-end*
- [x] **M3 — Cluster** (multi-node kind + Calico; full manifests, deployed + verified) — *2026-07-30*
- [ ] **M4 — Observability** (Prometheus scrape + Grafana dashboards + metrics-server + KEDA)
- [ ] **M5 — Baseline evidence** (CPU-HPA + k6 spike → "CPU flat, no scale, p99 blows past 200ms" → challenge #1)
- [ ] **M6 — Real autoscaler** (KEDA RPS/pod, empirical target, up-fast/down-slow + fallback → demo 2→N→2 → challenges #3/#4)
- [ ] **M7 — Load-sharing** (even per-pod distribution; keep-alive → challenge #2)
- [ ] **M8 — Resilience / chaos** (kill pod + kill Redis under load → drain §O2 + fail-open §O3)
- [ ] **M9 — Wrap** (writeup, README, Makefile polish, transcript cleanup)

## Status vs deliverables (§8)

- [x] Source + manifests + Dockerfile + Makefile — *source ✅ + Dockerfile ✅ + k8s manifests ✅ + Makefile ✅*
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

### 2026-07-30 17:16 — Milestone 2: Containerize ✅ (runs end-to-end)
Built the stack and **verified live** (Docker 28, compose).
- **`Dockerfile`** — multi-stage: `node:20-alpine` builder (tsc build + `npm prune --omit=dev`) → **distroless** `nodejs20-debian12:nonroot` runtime (no shell/pkg-mgr, uid 65532, §S4). Image **209MB**.
- **`docker-compose.yml`** — service + `postgres:16-alpine` + `redis:7-alpine`; secrets from `.env` via `${VAR:?}`; `init.sh` mounted to `docker-entrypoint-initdb.d`; app connects as least-priv role; superuser distinct; healthchecks (pg_isready / redis-cli PONG / node HTTP for distroless); `depends_on: condition: service_healthy`.
- **`.dockerignore`** (keeps `.env`/docs/db out of image), **`Makefile`** (help/up/down/logs/ps/smoke/clean), **`scripts/smoke.sh`**.
- Added `POSTGRES_SUPER_PASSWORD` to env files.

**Live verification (all green):**
- Stack: postgres/redis/iocheck all **healthy**; service logs "redis ready" + "listening".
- Smoke: seeded malicious IP → malicious; unknown → unknown; **upsert `Evil.COM` → stored `evil.com`** (normalization); lookup `evil.com` → malicious; **IPv6: upsert `::1`, lookup `0:0:0:0:0:0:0:1` → malicious** (canonicalization); no-key → **401**; bad sha256 → **400**; metrics show **type/verdict labels, no IOC value**.
- Resilience: oversized body → **413**; **Redis stopped → lookup still served from Postgres** (fail-open), **readyz stays 200 with `cache:false`** (Redis is soft, not a SPOF), `cache_up=0`; **Redis restarted → background reconnect → `cache_up=1`, readyz cache:true** (§O3 proven live).

*Note: stack left running; `make down` to stop, `make clean` to also drop the pgdata volume (smoke left `::1`/`evil.com` rows).*

**Evidence saved** (committed under `logs/`, indexed in [logs/README.md](../logs/README.md)):
`M1-unit-tests.log`, `M2-stack.log`, `M2-smoke.log`, `M2-resilience.log` — each with a capture timestamp
+ reproduce command. Reusable scripts: `scripts/smoke.sh`, `scripts/resilience.sh`. `.gitignore` adjusted
so `logs/` is tracked (evidence) while stray root `*.log` stays ignored.

### 2026-07-30 17:49 — Milestone 3 (part 1): cluster foundation ✅
- Tooling: installed **kind v0.32.0** + **helm v4.2.3** via brew (kubectl v1.32.2 already present).
- **`k8s/kind-config.yaml`** — 3-node cluster (1 control-plane + 2 workers) with **`disableDefaultCNI: true`** + podSubnet 192.168.0.0/16, so we run **Calico** instead of kindnet (kindnet doesn't enforce NetworkPolicy §S5).
- **Makefile** k8s targets: `cluster-up`, `calico`, `k8s-image`, `kind-load`, `cluster-status`, `cluster-down`.
- Created cluster (k8s **v1.36.1**); nodes NotReady until CNI. Installed **Calico v3.28.2** → `calico-node` 3/3 Running → **all 3 nodes Ready**. NetworkPolicy enforcement now active.
- **Next (M3 part 2):** author + apply manifests — namespace, ConfigMap, Secret, Postgres (StatefulSet+PVC, init via ConfigMap), Redis, iocheck Deployment (probes / securityContext §S4 / resources / preStop §O2 / topology spread §O5 / SA), Service, PDB(minAvailable=2 annotated §O4), NetworkPolicy default-deny + allow-list §S5; then `kind-load` the image and verify readyz gating.

### 2026-07-30 18:21 — M3 cluster hardening (Andre review) → pin + vendor + version-align
Andre flagged 2 supply-chain concerns; Claude found 4 more. Addressed:
1. **Pin node image** ✅ — `kind-config.yaml` now pins `kindest/node:v1.32.5@sha256:e3b2327e…` (manifest-**list** digest, arm64-safe — caught that the first `docker manifest inspect` digest was a per-platform sub-manifest, not the list).
2. **Vendor Calico** ✅ — saved `k8s/calico-v3.28.2.yaml` (248K); Makefile `calico` target now `kubectl apply -f` the local copy (no runtime curl from GitHub).
3. **Version skew** (client 1.32.2 vs server 1.36.1, 4 minors) → **pinned k8s to v1.32.5** to match kubectl → now client 1.32.2 / server 1.32.5 (aligned).
4. **Calico 3.28 ahead of matrix on 1.36** (tested through ~1.31) → the 1.32 pin also brings k8s within Calico's supported range.
5. *(carry to M3 pt2)* app image must NOT be `:latest` → use a **versioned tag** + `imagePullPolicy: IfNotPresent`/`Never` (kind-loaded; `Always` would try a registry).
6. *(writeup)* Calico's container images are pinned by **tag** not digest in the vendored manifest → full air-gap would pin-by-digest + mirror to a private registry.
- **Recreated** the cluster from the pinned config + vendored Calico → **3 nodes Ready at v1.32.5**, skew resolved.

### 2026-07-30 18:43 — Milestone 3 (part 2): manifests deployed + verified ✅
Authored full k8s manifests and deployed to kind; **verified live** (evidence: `logs/M3-k8s.log`).
- **Manifests** (`k8s/manifests/`): `00-namespace` (PSA=**restricted** §S4 + least-priv SA, no token automount); `10-config` (ConfigMap); `20-postgres` (StatefulSet+PVC, headless Svc, init.sh via ConfigMap, uid 70 rootless, exec probes); `30-redis` (Deployment+Svc, uid 999, readOnlyRootFS, emptyDir, auth'd exec probes); `40-iocheck` (Deployment replicas=2 + Svc: securityContext §S4 [nonroot/RO-rootfs/drop-ALL/seccomp], 3 probes [liveness=healthz process-only, readiness=readyz §O3], **preStop node-sleep** §O2, terminationGracePeriod 30, **topologySpread** §O5, **maxUnavailable:0/maxSurge:1** §O4, image `iocheck:0.1.0` + `imagePullPolicy: IfNotPresent` #5, envFrom config + secretKeyRef); `50-pdb` (minAvailable=2, loud §O4 annotation); `60-networkpolicy` (default-deny + DNS + iocheck→pg/redis egress + pg/redis ingress-from-iocheck-only + iocheck:3000 ingress §S5).
- **Plumbing:** `k8s/secret.example.yaml` (template; real Secret via `make secret` from `.env`, never committed §S2); Makefile `secret`/`deploy`/`undeploy` + versioned `IMAGE=iocheck:0.1.0`.
- **Live verification:** rollout 2/2; **iocheck pods spread across worker + worker2** (§O5); postgres/redis Running; **readyz db+cache true**; lookup + **normalized upsert** (`K8S-Evil.COM`→`k8s-evil.com`) work; **PDB ALLOWED DISRUPTIONS = 0** (zero eviction budget by design §O4, confirmed live); **NetworkPolicy segmentation PROVEN** — a non-iocheck busybox pod is **BLOCKED** from postgres:5432 and redis:6379 (§S5; Calico enforcing, kindnet wouldn't). All under restricted PSS.
- Evidence: `logs/M3-k8s.log`; reusable `scripts/k8s-verify.sh`.

### Open items to carry forward
- [ ] Cache-stampede protection (singleflight + jittered TTL) before load testing.
- [ ] Wire audit log on `/ioc` (§S7) — currently only pino request logging.
- [ ] Rate limiting (§S9) — deferred, decide build vs writeup.
- [ ] M3 pt2: app image versioned tag (not `:latest`) + `imagePullPolicy: IfNotPresent` (concern #5).
- [ ] Writeup: pin Calico container images by digest + mirror for air-gap (concern #6).
