# iocheck — Build Journal

Dated record of progress, checked against [`plan.md`](./plan.md). Legend: `[x]` done · `[~]` in progress · `[ ]` not started.
(The **plan** = design; the **transcript** = AI chat log; this **journal** = what actually got built, when.)

---

## Status vs plan build sequence (§9)

- [x] **M1 — Service** (Express + zod + metrics + read-through cache + auth + graceful shutdown) — *2026-07-30*
- [x] **M2 — Containerize** (Dockerfile, docker-compose: service + pg + redis) — *2026-07-30; runs end-to-end*
- [x] **M3 — Cluster** (multi-node kind + Calico; full manifests, deployed + verified) — *2026-07-30*
- [x] **M4 — Observability** (Prometheus + Grafana + metrics-server + KEDA; cadvisor CPU overlay) — *2026-07-30*
- [x] **M5 — Baseline evidence** (CPU-HPA + k6 spike → challenge #1 PROVEN) — *2026-07-30*
- [x] **M6 — Real autoscaler** (KEDA on in-flight concurrency → demo 2→7→2 → challenges #3/#4) — *2026-07-31*
- [x] **M7 — Load-sharing** (even per-pod distribution; keep-alive churn fix) — *folded into M6: per-pod RPS even across 7 pods → challenge #2 PROVEN*
- [ ] **M8 — Resilience / chaos** (kill pod + kill Redis under load → drain §O2 + fail-open §O3) — *EXTRA (not a required challenge); needs a storm → defer to fresh session (fail-open already shown idle in M2)*
- [ ] **M9 — Wrap** (writeup, README, Makefile polish, transcript cleanup)

## Status vs deliverables (§8)

- [x] Source + manifests + Dockerfile + Makefile — *source ✅ + Dockerfile ✅ + k8s manifests ✅ + Makefile ✅*
- [x] README (reproduces setup from clean state) — *`make cluster-down && make all` VERIFIED clean (2026-07-31); prose pending Andre review*
- [x] Load-test tool (k6 script) — `k8s/loadtest/lookup-storm.js` + `make loadtest`
- [~] Writeup (~1–2pp: architecture + 4 answers + data-source-down + one-week + security posture) — *REPORT.md drafted; Andre to review*
- [x] AI chat logs — `docs/transcript.md` (recording, verbatim + timestamps)

## Four challenges (§7) — ALL DEMONSTRATED

- [x] #1 Why CPU HPA is wrong (measured evidence) — M5: CPU ~10–35% (peak ~59%, still <70%), replicas pinned at 2, p99 ~5s (`logs/M5-cpu-hpa-baseline.log`)
- [x] #2 Pods share load (keep-alive trap) — M6: per-pod RPS even across 7 pods (`noConnectionReuse` churn fix)
- [x] #3 Autoscaler up & down, defend min/max — M6: KEDA concurrency 2→7→2, min2/max8 defended
- [x] #4 Reproducible test — M6: `k8s/loadtest/lookup-storm.js` + `make loadtest`

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

### 2026-07-30 20:02 — Milestone 4 step 1: observability core ✅ (verified)
Built + verified the observability core (evidence: `logs/M4-observability.log`).
- **D3 buckets widened** — `metrics.ts` histogram now `…1,2,3,5` (so a 2–3s p99 isn't clipped); bumped to **iocheck:0.1.1** (immutable tag), rebuilt/loaded/rolled out; confirmed `le="3"`,`le="5"` present.
- **metrics-server** — vendored `k8s/metrics-server-v0.7.2.yaml` + patched `--kubelet-insecure-tls` (kind); `kubectl top` works (iocheck idle ~13m → the reason CPU-HPA won't fire under I/O-bound load).
- **Prometheus** (minimal, `k8s/monitoring/10-prometheus.yaml`) — SA+ClusterRole (pods/nodes/cadvisor), scrape config (pod SD, keep app=iocheck:3000, 5s interval), pinned `prom/prometheus:v2.54.1`; **both iocheck pods scraped UP**; queries (RPS/p99/replicas) return.
- **Grafana** (`20-grafana.yaml`, pinned `grafana/grafana:11.2.0`) — provisioned datasource (uid=prometheus) + **dashboard-as-code** (`grafana-dashboards/iocheck-overview.json`: RPS, p99 w/ 200ms threshold line, in-flight, replicas via `count(up{job=iocheck}==1)`); anonymous viewer on; verified datasource+dashboard load + end-to-end Grafana→Prom query.
- **KEDA** — vendored `k8s/keda-2.17.1.yaml` (v2.17 supports k8s ~1.30–1.32); all pods Ready, **external-metrics APIService `Available=True`** (ready for the M6 Prometheus scaler).
- **Makefile**: `metrics-server`/`prometheus`/`grafana`/`keda`/`observability` + `grafana-open`/`prometheus-open`.
- **Step 2 (next, non-blocking):** cadvisor scrape → fold container **CPU** into the same Grafana overlay (RPS/p99/replicas/CPU on one panel). Core stands without it (`kubectl top`/HPA as fallback).

### 2026-07-30 20:19 — Milestone 4 step 2: cadvisor CPU overlay ✅
- **Prometheus cadvisor scrape** — added a `cadvisor` job (node SD → API-server proxy `/api/v1/nodes/<n>/proxy/metrics/cadvisor`, bearer token + `insecure_skip_verify`; RBAC already granted nodes/proxy + `/metrics/cadvisor`). Restarted Prometheus → 3 node targets UP → `container_cpu_usage_seconds_total{namespace=iocheck}` available (~9m/pod idle).
- **Dashboard updated** (`iocheck-overview.json`, now v2, **title de-em-dashed → "iocheck overview"**): added **CPU per pod (millicores)** panel w/ 70m HPA-trigger threshold line, and the headline **"Challenge #1 — CPU % of request vs p99"** dual-axis overlay (CPU% left w/ 70% threshold, p99 right) — the panel that IS the challenge-#1 evidence. Recreated CM + restarted Grafana → all 6 panels load; CPU queries return (16.9% idle, 2 pod series).
- **M4 fully complete.** Note: the *visual* money-shot (CPU flat while p99 spikes) is only populated under load → captured in **M5** with k6. Panel titles still contain em-dashes (cosmetic; offered to sweep).

### 2026-07-30 20:40 — Plan fix: KEDA query feedback-loop (Andre catch, pre-M6)
Andre flagged the draft §4c query `sum(rate(...)) / count(kube_pod_info)` as a self-defeating feedback loop. **Confirmed correct.**
- **Mechanism:** KEDA Prometheus scaler defaults to `metricType: AverageValue` → HPA does `desired = ceil(query / threshold)` (NO currentReplicas term). Dividing the query by pod count normalizes *twice* → oscillation (total 800, thr 100: N=2→q400→d4; N=4→q200→d2; flap).
- **Fix (§4c updated):** query returns **TOTAL** `sum(rate(http_requests_total{namespace="iocheck",route="/lookup"}[1m]))`; `threshold` = per-pod target; explicit `metricType: AverageValue`; `serverAddress: http://prometheus.monitoring.svc:9090`. Incoming RPS is client-driven → total stable as N changes → no feedback.
- **Bonus fixes:** `kube_pod_info` doesn't exist (no kube-state-metrics in minimal stack); added `route="/lookup"` filter so probe/scrape traffic doesn't inflate the signal.
- Rule for the call: *"query=aggregate, threshold=per-pod; KEDA divides. Pre-dividing double-normalizes and oscillates."* To be applied when we author the ScaledObject in M6.

### 2026-07-30 20:55 — Plan: documented M5 evidence pitfalls (§6a) before building
Andre asked to enumerate + document M5 pitfalls first (evidence-gathering is the trickiest part). Added **plan §6a — M5 evidence pitfalls** (14 items, 4 groups): A) signal integrity (CPU util <70%, concurrency-not-throughput bound, PG-pool cliff vs connectionTimeout); B) k6 load design (distinct values, uniqueness > neg-cache TTL, keep-alive pinning, hold spike, in-cluster own-ns); C) laptop host-CPU contention + metrics-server 15s lag; D) faithful baseline (replicate team's 70%/min2/max8), CPU-real-not-`<unknown>`, one-autoscaler-at-a-time, aligned reproducible capture. Andre's 3 (CPU-sizing, distinct-unknowns, hold-spike) confirmed + folded in. Two prep items added to carry-forward (pool-timeout env, delete CPU-HPA before KEDA).

### 2026-07-30 21:04 — §6a extended: +2 M5 pitfalls (Andre)
Andre added two more, both folded into plan §6a (now 16 items):
- **#4 (group A) No CFS throttling** — confirm `rate(container_cpu_cfs_throttled_seconds_total[1m])≈0` during the storm. Throttling injects latency (confounds "latency is I/O") AND zero-throttle is *positive* evidence CPU isn't the bottleneck. <70m HPA trigger is ~7× under the 500m limit → should hold, but verify (cadvisor already scraped in M4-step2 → metric available; could add a dashboard panel in M5).
- **#15 (group D) No OOM/pod restarts mid-run** — a restart contaminates evidence (spurious replica change, restart latency, cold cache). Watch mem working-set vs 256Mi limit; verify `RESTARTS=0` + no `OOMKilled` before trusting a run; may need to bump mem limit if OOM under load.

### 2026-07-30 21:39 — M5 smoke run: thesis INVERTED (key finding) → Option A
Built k6 (cache-miss storm, in-cluster Job hitting the Service FQDN, `lookup-storm.js` + `k8s/loadtest/` + Makefile `loadtest`). Prep done first: **PG `connectionTimeoutMillis` env-configurable** (`PG_CONNECTION_TIMEOUT_MS`, default 10000) + **mem limit 256→512Mi** + **v0.1.2**.

**Smoke result (2.5-min storm, 60 VUs) — the thesis did NOT hold:**
- CPU **~480m/pod** (= **480% of the 100m request**, near the 500m limit) — CPU-HPA *would* fire.
- p99 only **~0.2–0.44s** (not the 2–3s the prompt describes).
- **Heavy CFS throttling** (~1.9 throttled-s/s) — the latency we saw was partly throttle-induced, not I/O queueing.
- Restarts **0** (pitfall #15 clean).

**Why (queueing theory, not a bug):** our service is **CPU-bound, not I/O-bound**. A PK lookup on a tiny Postgres table is sub-ms → the pool never saturates → no I/O queue → at high RPS the app's per-request CPU (JSON/zod/pino/prom/driver) dominates → CPU saturates + throttles. **Seconds-of-latency requires a slow downstream; our DB is too fast.** (This is *why* the team's premise exists — their store was genuinely slow; ours isn't, so it doesn't reproduce their symptom.)

**Decision — Option A: model a realistic backing-store latency** (Andre: "more repeatable" than Option B's big-dataset approach). **Two Andre refinements (both correct, adopted):**
1. **Latency must hold a pool connection** — model it *in the DB round-trip* (a `pg_sleep` on a held pooled client), NOT a bare app-side `setTimeout` (which wouldn't occupy a pool slot → pool wouldn't saturate → no queueing).
2. **Co-tune CPU request + verify the full signature** — larger modeled latency caps throughput low → drops CPU further *and* is more defensible (models a remote feed/enrichment lookup). Measure CPU at capped throughput, size request so util lands comfortably <70%. **Acceptance test = all three: p99 → seconds AND CPU util <70% AND CFS throttle ≈ 0.** Also trim per-request logging to cut CPU baseline.

**Next:** implement `STORE_LOOKUP_LATENCY_MS` via `pg_sleep` on a held connection (findIoc path) + trim pino per-request logging + bump 0.1.3 → run the co-tuning loop until the 3-condition signature holds → then the CPU-HPA baseline capture.

### 2026-07-30 22:03 — M5 co-tuning: implemented modeled latency + swept L (Option A)
Implemented Option A: `STORE_LOOKUP_LATENCY_MS` via **`pg_sleep` on a held pooled connection** (repository.findIoc) so it occupies a pool slot (Andre's requirement) + disabled per-request access logging (CPU + §S7 privacy). v0.1.3.
**Latency sweep (60 VUs, 2 pods, pool=10, measuring the 3-condition signature):**
- **L=300ms:** p99 ~2–3s ✓, but CPU ~100–130% of 100m request ✗ (throughput too high).
- **L=900ms:** p99 ~5s (clipped at top bucket — too slow) ✗, CPU still bursty ~42–78%.
- **L=700ms + right-size request 100→150m:** **p99 ~3s ✓, throttle ~0 ✓, restarts 0 ✓, CPU util steady ~40–55% ✓** — BUT transient burst to **~86% (CPU ~130m)** during the load ramp.
- **Finding:** per-request CPU (~2–4ms: zod + ipaddr-normalize + json + prom + 2 pg round-trips) is a floor, so CPU tracks *arrival* rate; low CPU needs low throughput (higher L) or a right-sized request. L=700 models a realistic slow remote reputation/feed lookup on cache miss.
- **Open decision (→ Andre):** the ramp burst to ~86% util risks a CPU-HPA briefly scaling to 3 → contaminating the "pinned at 2" evidence. Fix = **request 150→200m** (usage bursts 130m → 65% util, always <70%; principled: size request so normal bursts sit under the trigger). Awaiting sign-off on L=700 + request=200m before the baseline capture.

### 2026-07-30 22:30 — Milestone 5: CHALLENGE #1 PROVEN ✅ (evidence captured)
Locked demo config (Andre signed off both): **L=700ms** (models a slow remote reputation/feed lookup; calibrated to reproduce the prompt's stated 2–3s p99; env-gated, off by default, documented) + **cpu request 200m** (right-sized to peak usage ~130m + headroom → even ramp bursts <70%). Applied the team's failed config as a throwaway HPA (`k8s/baseline/cpu-hpa.yaml`: Utilization 70%, min2/max8).

**Baseline capture (evidence: `logs/M5-cpu-hpa-baseline.log`):**
- **HPA CPU util ~10–35% (peak ~59%), always < the 70% trigger → REPLICAS pinned at 2** the entire storm — CPU-HPA never scaled.
- **p99 breached to ~3–5s** (k6: avg 1.96s, med 2s, p95 2.94s, max 6.69s) — 15–24× the 200ms SLO.
- **k6 SLO gate `p(99)<200ms` FAILED** (documented proof); **100% status-200, 0 failures** (3413 reqs) → latency is *pure queueing*, not 500s (connection-timeout tuning §6a#3 worked).
- **CFS throttle ~0** (§6a#4 ✓); **restarts 0** (§6a#15 ✓).
- **Grafana money-shot now populated** (dashboard "Challenge #1 — CPU% vs p99" panel): CPU flat ~15–35% while p99 spikes to seconds, replicas flat at 2.

**Verdict:** CPU is blind to the I/O bottleneck — proven with measured evidence, not theory. All §6a acceptance conditions met. Config bumped to **v0.1.3**.

**M6 prep:** delete `iocheck-cpu` HPA before applying KEDA (§6a#13). Per-pod capacity ≈ 14 lookup-RPS/pod at saturation (L=700, pool=10) → KEDA per-pod threshold ~10–12 RPS.

### 2026-07-30 22:37 — Fix: dashboard CPU panels were stale (100m→200m request) + evidence doc
Andre captured the money-shot screenshots — which surfaced a bug: the Grafana CPU panels still assumed the
**old 100m request** (`1000*avg(rate)`=millicores="% of 100m", threshold lines at 70), so after the
request→200m bump they **over-reported CPU by 2×** — the money-shot showed CPU cresting ~100% and *crossing*
the 70% line, contradicting the real HPA reading (10–35%). **Fixed:** money-shot CPU% expr → `100*avg(rate)/0.2`
(% of 200m); per-pod panel threshold 70→**140m** + title "(70% of 200m request)". Redeployed; 22:25 storm data
still in Prom (2h) → re-captured without re-running. Created **`docs/evidence/README.md`** with captions + the
one-sentence takeaway; PNGs to be saved as `challenge1-overview.png` + `challenge1-cpu-vs-p99.png`.

### 2026-07-30 22:45 — Money-shot finalized (axes pinned; threshold lines visible)
Pinned the money-shot CPU axis 0–100% (70% line now in frame) + per-pod panel 0–160m (140m line in frame),
redeployed. After a hard refresh Andre re-captured: **money-shot shows CPU% peaking ~54% clearly UNDER the
red 70% trigger line while p99 spikes to ~5s** — the definitive challenge-#1 image. Overview: CPU per pod
~108m under the 140m line, RPS ~28, replicas flat at 2. Added a caption note re: the tiny replicas blip to 3
at ~22:21 = rolling-update surge (maxSurge:1) from the pre-run redeploy, NOT the CPU-HPA. Screenshots to be
saved as `docs/evidence/challenge1-{overview,cpu-vs-p99}.png`.

### 2026-07-31 01:06 — M6 pre-build: p99 decision + pitfalls documented (plan §6b)
Discussed M6 framing before building. **Confirmed:** M5=wrong-signal consequences, M6=right-signal→proper
scaling; #3 (scale up/down + defend min/max), #4 (reproducible), + #2 (load spreads to new pods).
**Key decision (locked):** 700ms = a *hard p99 floor* (miss ≥700ms; scaling removes queueing not service
time) → `p99<200ms` and the 700ms all-miss storm are mutually exclusive → **keep 700ms (clean A/B vs M5),
LIFT the <200ms target**; M6 win = **2→N→2 + p99 ~5s→~1s**; `<200ms` addressed honestly via the cache in
REPORT (optional cache-friendly mini-demo). **Added plan §6b** (M6 build plan + 7 pitfalls): scale-down slow
(use 60–120s demo window), **⚠ keep-alive pins load to OLD pods on scale-up → k6 must churn connections**
(else new pods idle), RPS capacity-coupling, delete CPU-HPA first, scale-up lag (~1min), DB conn ceiling
(80<100), fallback demo. Manifest = `k8s/manifests/70-keda-scaledobject.yaml` per §4c. **Next: build M6.**

### 2026-07-31 01:37 — M6 finding: RPS signal fails under saturation → switch to CONCURRENCY (Option B)
**Ran the KEDA RPS scaler (threshold 12/pod) → it did NOT scale** (replicas stuck at 2, p99 5s — reproduced M5). Root-caused with evidence:
- **Log (`logs/M6-keda-scaling.log`):** during the storm, KEDA's measured RPS/pod hovered ~10–12 (e.g. 11958m), totRPS ~24, replicas 2, p99 5s.
- **HPA math:** AverageValue → `desired = ceil(totalRPS/threshold) = ceil(24/12) = 2`; also within the HPA's ~10% no-action tolerance (`12.4/12 = +3%`). So no scale-up.
- **Root cause:** the pool caps completed throughput (20 slots ÷ 0.7s ≈ 28/s), **pinning completed-RPS to ~12/pod regardless of overload** — a *capacity-limited*, not load-driven, signal.
- **Smoking gun (both signals, SAME storm, from Prometheus):** completed **RPS/pod ≈ 12.4** (at threshold → no scale) vs **in-flight/pod ≈ 40** (steady ~30; total in-flight ~60–81). Concurrency isn't pool-capped (a queued request still counts in-flight) → it reflects the real offered load (60 VUs).
- **Decision → Option B: scale on in-flight CONCURRENCY per pod.** `query = avg_over_time(sum(http_in_flight_requests{ns=iocheck})[30s:5s])`, `metricType AverageValue`, threshold ~10/pod → `desired = ceil(60/10) = 6`; at 6 pods 60/6 = 10 = target → **clean 2→6→2**. (RPS→concurrency is empirically justified; RPS retained as a "future work / why not RPS" writeup point.) Verify by re-running the storm.

### 2026-07-31 01:47 — M6 Option B (concurrency) VERIFIED: 2→7→2, load spread, p99 5s→2s
Switched ScaledObject trigger to in-flight concurrency (`avg_over_time(sum(http_in_flight_requests{ns=iocheck})[30s:5s])`, AverageValue, threshold 10/pod), re-ran the SAME storm → **the deduction held** (evidence: `logs/M6-keda-concurrency.log`):
- **Scale-up 2→5→6→7** as in-flight climbed 60→75 (KEDA read ~21/pod at 2 pods → scaled). **Challenge #3 (up).**
- **Challenge #2 — churn fix works:** at 7 pods per-pod lookup-RPS was `10.2,10.3,10.9,10.7,11.0,10.1,10.5` — **even across ALL 7 pods incl. new ones** (noConnectionReuse spread the load).
- **p99 ~5s → ~2s** (queue relieved by scaling). **Scale-down 7→6→3→2** ~60s after load stopped (60s window). **Challenge #3 (down) + #4 (reproducible).**
- **A/B proof (same workload):** RPS signal → stuck at 2 / p99 5s; concurrency signal → 2→7→2 / even load / p99 halved.
- **Notes:** landed at 7 not ~6 (in-flight ran ~70–75, not exactly 60; 7 pods held within HPA ~10% tolerance). p99 settled ~2s with occasional 5s spikes — in-flight (~75) slightly exceeds the 7-pod pool (70) → residual queue; a threshold ~8 (→8 pods, pool 80>75) would give a cleaner sub-1s p99 if we want a crisper money-shot.
- **Remaining M6:** optional threshold tweak for cleaner p99; Grafana M6 money-shot (scaling); fallback demo (Prometheus down → KEDA fallback=4, §6b#7).

### 2026-07-31 02:25 — M6 WRAPPED: all 4 challenges demonstrated; threshold=8 polish deferred
- Reverted to **threshold=10** (matches the verified 2→7→2 evidence). The threshold=8 "crisper p99" re-run **failed environmentally** (host CPU pegged ~490% → API timeouts, liveness-triggered pod restarts [clean `Completed` exits, NOT OOM], k6 job errored → no load); it also overwrote the M6 log, but the good 01:41 data (peak replicas=7) is retained in Prometheus.
- **Money-shot captured** from the retained 01:41 data (re-cropped to 01:38–01:50): `docs/evidence/m6-challenge3-keda-scaling.png` — replicas hold at 7 while **p99 drops 5s→2s mid-load** (scaling drains the queue in real time), then 7→2. + `m6-overview.png`, `m6-cpu-vs-p99.png`. Evidence README updated.
- **M6 done. All 4 required challenges DEMONSTRATED** (#1 M5; #2/#3/#4 M6). M7 (load-sharing) folded into M6.
- **Remaining:** M8 (chaos — EXTRA, not a required challenge; defer to fresh session), then M9 (writeup + README + Makefile polish). *Corrected my earlier "just writeup after M6" — M8 exists but is optional extra credit.*

### 2026-07-31 02:39 — M9 drafted (writeup + README + Makefile) — awaiting Andre review
Fixed transcript Turn 41 → split into verbatim Turns 41–45. Confirmed M7 done (folded M6), M8 extra/deferred.
Drafted M9 (cluster-free, doc-only):
- **`REPORT.md`** (~2pp): architecture; the 4 challenges w/ evidence links; the honest **modeled-latency disclosure** + **RPS→concurrency** finding; data-source-down (KEDA `fallback: 4` + Redis fail-open); security posture; "with another week"; AI-tools disclosure.
- **`README.md`**: prepended a solution overview + **reproduce-from-clean** section (`cp .env.example .env` → `make all` → `make loadtest`) + repo layout; kept the StrongKeep brief below.
- **`Makefile`**: added **`make all`** (cluster-up → calico → deploy → observability) for one-command clean spin-up.
- Deliverables now: source/manifests/Dockerfile/Makefile ✅, k6 tool ✅, AI logs ✅, README ~ (draft), Writeup ~ (draft).
- **Remaining:** Andre reviews REPORT/README; optional M8 chaos (fresh session); then commit + submit.

### 2026-07-31 03:05 — Fix: `make all` ordering bug (Andre catch)
Andre spotted that `all: cluster-up calico deploy observability` would fail on a fresh cluster: **`deploy`
(`kubectl apply -f k8s/manifests/`) applies `70-keda-scaledobject.yaml` (`kind: ScaledObject`,
`keda.sh/v1alpha1`), but the KEDA CRD isn't installed until `observability` (step 4)** → "no matches for
kind ScaledObject". Verified via sources (deploy's apply target + the manifest kind + which step installs
KEDA). **Fix: reordered to `cluster-up → calico → observability → deploy`** (platform incl. KEDA first, then
app; within deploy's bulk apply the Deployment `40-…` still precedes the ScaledObject `70-…` alphabetically).
Also fixed the two docs that showed the wrong order (README reproduce comment + REPORT reproduce line → `make
all`). `make -n all` parses OK. Full end-to-end `make all` on a *fresh* cluster is the remaining verification
(deferred — avoid thrashing tonight's fragile cluster).

### 2026-07-31 03:19 — Fact-check sweep of REPORT/README vs the logs (Andre catch)
Andre flagged REPORT's "CPU ~10–35%" contradicting its own linked log (which peaks **59%** at 22:27:27). Swept everything:
- **BIG find:** `logs/M6-keda-concurrency.log` had been **overwritten** by the errant threshold=8 run (header said "threshold=8", all rows REPS=2, empty columns) — the "2→7→2 / per-pod 10.2,10.3,…" evidence REPORT #2/#3 cites was gone. **Restored** from the captured **threshold=10** run (01:41–01:47, the run the screenshot shows) with a provenance note.
- **CPU number** corrected `~10–35%` → **`~10–35% for most of the storm, peaking ~59% (still <70%)`** in: REPORT #1, `logs/M5-cpu-hpa-baseline.log` VERDICT (was "15–34%"), `logs/README.md` M5 row, journal (challenges checklist + M5 entry), `docs/evidence/README.md` (×2). *(Left the historical transcript summaries as-is — they're the record of what was said at the time.)*
- **Throttle** `~0` → **`low (≲0.4/s)`** (log peaks 0.42) in REPORT + logs README.
- **Backed REPORT #3's "in-flight ~40/pod vs RPS ~12/pod"** by adding the measured comparison (RPS/pod 12.4, in-flight/pod 40) to `logs/M6-keda-scaling.log` VERDICT.
- **Verified OK** (no change): p99 ~5s (25× SLO), replicas pinned at 2, k6 `p(99)<200` FAILED + 0 errors (3413 reqs), RPS capacity-coupled ~12/pod, 2→7→2, min=2/max=8 defense (§O4/§O8), fallback `replicas:4`, Redis fail-open, NetworkPolicy segmentation, security posture, README reproduce + `make all` order.

### 2026-07-31 09:42 — Clean spin-up VERIFIED end-to-end (`make cluster-down && make all`)
Ran the full clean rebuild (evidence: `logs/M9-clean-spinup.log`). **`make` exited 0.** The whole chain ran
in the fixed order — cluster-up → calico → observability (metrics-server/prometheus/grafana/**keda**) → deploy
— and critically **`scaledobject.keda.sh/iocheck created`** during deploy with NO "no matches for kind
ScaledObject" error → **the M9 ordering fix is confirmed end-to-end.** Post-run: 3 nodes Ready (v1.32.5);
iocheck ×2 (spread across both workers) + postgres + redis Running; Prometheus/Grafana/KEDA Running;
**ScaledObject READY=True, ACTIVE=True**; smoke test (healthz/readyz/lookup→malicious) passes. The earlier
host-CPU thrash was load-specific (storms) — a clean *build/deploy* runs fine. README "reproduce from clean
state" now VERIFIED. (Also regenerated a clean cluster; a fresh `make loadtest` would now give live M6 data.)

### 2026-07-31 09:55 — README/REPORT sweep vs the brief (Andre catches)
Andre spotted a spurious prereq + a brief-contradiction; swept README+REPORT against the brief's full requirement list. Fixes:
- **`helm` removed** from README prereqs — not used anywhere (Calico/KEDA/metrics-server are vendored raw manifests; Prom/Grafana are ours). (The brief's own "or Helm" line is StrongKeep's text — left as-is.)
- **`/readyz` deliberate-deviation now documented** in REPORT: brief says "200 only when DB *and cache*"; we gate on **Postgres only** because Redis-gating = SPOF (one blip → all pods NotReady → total outage) — Redis is soft/fail-open, reachability via `cache_up`. Added the explicit "(one-line change to honour the literal wording if required)" note.
- **Gaps the writeup missed (in code but not REPORT) — added:** all **3 probes** (startup/liveness/readiness), **requests + limits on every container**, cache **TTL + invalidate-on-`/ioc`-upsert**.
- **Full cross-check vs brief:** every requirement (API endpoints, storage+cache, workload, platform [kind/Dockerfile/manifests/probes/PDB/limits/autoscaling], 4 challenges, data-source-down, one-week, AI disclosure) now present in REPORT/README. No contradictions between our README section and REPORT.

### 2026-07-31 10:47 — §S8 hardening: /metrics port split (Andre catch)
Andre asked whether exposing `/metrics` on the public API port leaks the lookup patterns of an intel service. Nuance: we already keep **IOC values out of labels** (§S8), so specific lookups aren't leaked — but the **aggregate metadata** (verdict-by-type rates, request tempo) still reveals **SOC activity/tempo**, and it was served unauthenticated on the public port. Fix (standard app-port vs metrics-port separation):
- **Code:** `createMetricsApp()` serves `/metrics` on a new `METRICS_PORT` (9464); the instrumentation *middleware* stays on the public app (records real traffic), only the *exposition* endpoint moves. `index.ts` runs both listeners + drains both on SIGTERM. `config.ts` adds `METRICS_PORT`. Image → **0.1.4**.
- **Manifests:** deployment adds `containerPort: 9464 (metrics)`; ConfigMap `METRICS_PORT`; Prometheus scrape `keep regex "3000"→"9464"`; NetworkPolicy `iocheck-ingress` split into two rules — `:3000` open (clients/probes), `:9464` **from `namespaceSelector kubernetes.io/metadata.name: monitoring` only**.
- **Local dev:** docker-compose exposes 9464 + `METRICS_PORT`; smoke/resilience scripts curl `$METRICS_BASE` (9464); smoke also asserts `:3000/metrics`→404.
- **Verified live** ([`logs/S-metrics-port-split.log`](../logs/S-metrics-port-split.log)): `:3000/metrics`→404, `:3000/healthz`→200, `:9464/metrics`→200; Prometheus scrapes both pods `:9464` **up**; KEDA `status: Happy, 0 failures`, query readable; **NetworkPolicy** — from a `default`-ns pod, `:3000`→200 but `:9464`→timeout (blocked). Build + 15 unit tests pass (Node 20).
- **Docs:** REPORT architecture diagram + new "Metrics isolation" security bullet; plan §S8; metrics.ts EXPOSURE RULE; logs/README table.
- **Decision on further gaps:** do the **/ioc audit log** next if time permits (small, high-signal integrity trail — no infra); leave rate-limiting/TLS/per-identity as documented "with another week."

### 2026-07-31 10:58 — §S7: /ioc audit trail (image 0.1.5)
Added an audit trail to the crown-jewels write path. `auth.ts` stashes a credential fingerprint (`sha256(key)[:12]`, never the key) on success and logs `ioc_auth_denied` (warn + src_ip) on failure; the `/ioc` handler emits `ioc_upsert` (info) with actor, src_ip, and the mutated `type/value/source/score`. The IOC **value is logged on this write path deliberately** (an audit trail is useless without the mutated object) — the high-volume read path still logs no values (§S7/§S8 scoping). **Verified live** ([`logs/S-ioc-audit.log`](../logs/S-ioc-audit.log)): valid upsert→201 + `ioc_upsert`; bad key→401 + `ioc_auth_denied`; grep confirms the raw admin key never appears in logs. Build + 15 tests pass. Docs: REPORT AuthN/Z bullet (+removed audit-log from "with another week", now done), plan §S7, logs/README.

### 2026-07-31 11:10 — REPORT tightening (Andre): challenge #2 framing + #4 fallback math
- **#2 (load sharing):** Andre flagged that the old text implied we "fixed" load-sharing when `noConnectionReuse` is a *test-client* property. Validated his reasoning (Service LB is per-connection via conntrack; keep-alive pins to connect-time pod; real SOC clients won't rebalance). Rewrote #2: k6 churn now framed as *proof the Service balances once connections cycle*; added the server-side lever (`maxRequestsPerSocket`/`keepAliveTimeout` → force reconnect → re-route) and the fuller **L7 proxy/mesh** (per-request LB) answer. Not implemented — presented as production levers (consistent with PgBouncer/TLS framing); offered to wire `maxRequestsPerSocket` as a one-liner if wanted (won't disturb evidence since k6 already churns).
- **#4 (`replicas: 4` fallback):** tightened to a math argument — scaling is multiplicative, so the blind-hold count is the **geometric mean √(min·max)=√(2·8)=4 = 2×min = max/2**; symmetric ~2× scaling error either way vs 4× under-provision at min; backend-safe (4×10=40 in-flight/DB conns < 100).
- Doc-only; no code/manifest change, cluster untouched (still 0.1.5).

### Open items to carry forward
- [ ] Cache-stampede protection (singleflight + jittered TTL) before load testing.
- [x] Wire audit log on `/ioc` (§S7) — DONE (ioc_upsert + ioc_auth_denied, 2026-07-31).
- [ ] Rate limiting (§S9) — deferred, decide build vs writeup.
- [x] ~~M3 pt2: app image versioned tag + imagePullPolicy~~ (done in M3 pt2 / M4).
- [ ] Writeup: pin Calico container images by digest + mirror for air-gap (concern #6).
- [ ] **M5 prep:** make PG pool `connectionTimeoutMillis` env-configurable (pitfall §6a#3/#5) so p99 climbs cleanly instead of erroring under pool saturation.
- [ ] **M5:** CPU-HPA (70%, min2/max8) is a throwaway — **delete before M6 KEDA** (pitfall §6a#13).
