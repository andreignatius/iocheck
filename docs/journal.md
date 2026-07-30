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
- **HPA CPU util 10–35%/70% → REPLICAS pinned at 2** the entire storm — CPU-HPA never scaled.
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

### Open items to carry forward
- [ ] Cache-stampede protection (singleflight + jittered TTL) before load testing.
- [ ] Wire audit log on `/ioc` (§S7) — currently only pino request logging.
- [ ] Rate limiting (§S9) — deferred, decide build vs writeup.
- [x] ~~M3 pt2: app image versioned tag + imagePullPolicy~~ (done in M3 pt2 / M4).
- [ ] Writeup: pin Calico container images by digest + mirror for air-gap (concern #6).
- [ ] **M5 prep:** make PG pool `connectionTimeoutMillis` env-configurable (pitfall §6a#3/#5) so p99 climbs cleanly instead of erroring under pool saturation.
- [ ] **M5:** CPU-HPA (70%, min2/max8) is a throwaway — **delete before M6 KEDA** (pitfall §6a#13).
