# iocheck — Build & Scale Plan

StrongKeep take-home. Build a threat-intel IOC lookup service and make it autoscale on the
*actual* workload signal, with measured evidence. This doc is the gameplan; it maps every
assignment requirement + the four challenges to a concrete decision.

---

## 0. Locked stack (with one-line justifications)

| Layer | Choice | Why |
|---|---|---|
| Service | **TypeScript + Express** | required TS; Express is defensible cold ("defend every line") and is *not* the bottleneck |
| Validation | **zod** | typed request/response for `/lookup` + `/ioc`; closes Express's gap vs Fastify |
| Metrics | **prom-client** | exposes `/metrics`; the RPS + latency histograms the autoscaler reads |
| Persistent store | **PostgreSQL** | relational, unique `(type, value)` lookup, `source/score/added_at`; upsert via `ON CONFLICT` |
| Cache | **Redis** | read-through, TTL, invalidate-on-upsert; the reason p99 stays low on hits |
| Container | **Docker** | required |
| Cluster | **kind** | vanilla/full k8s, closest to prod, clean Makefile spin-up |
| Metrics pipeline | **Prometheus + Grafana** | scrape `/metrics`; Grafana = the *evidence* for challenge #1 |
| Autoscaler | **KEDA** (Prometheus scaler) | scales on **RPS/pod**, supports scale-to/from + `fallback` |
| Load test | **k6** (+ optional autocannon) | reproducible ramp→spike→ramp-down + machine-checked `p99<200ms` gate |

---

## 1. Architecture

```
                          kind cluster
  ┌──────────────────────────────────────────────────────────────┐
  │                                                                │
  │   k6 (in-cluster or host) ──POST /lookup──▶  Service (ClusterIP)│
  │                                                │ (round-robins) │
  │                                    ┌───────────┴───────────┐    │
  │                                    ▼                       ▼    │
  │                              iocheck pod              iocheck pod   ... (2..N, KEDA)
  │                              Express + zod            │
  │                                    │                  │
  │                    cache hit ┌─────┴─────┐ cache miss  │
  │                              ▼           ▼             │
  │                          Redis        PostgreSQL       │
  │                        (read-through)  (source of truth)│
  │                                                        │
  │   Prometheus ──scrape /metrics──▶ every pod            │
  │        ▲                                               │
  │        └── KEDA reads RPS/pod query ──▶ scales Deployment
  │                                                        │
  │   Grafana ── dashboards (CPU vs RPS vs p99 vs replicas)│
  └──────────────────────────────────────────────────────────────┘
```

**Request flow (`POST /lookup`):**
1. Validate body with zod (`type ∈ {ip,domain,sha256}`, `value` non-empty).
2. Read-through cache: `GET cache[type:value]`.
   - **Hit** → return verdict (sub-ms + network).
   - **Miss** → Postgres lookup by `(type, value)`; populate cache with TTL; return.
3. Record Prometheus metrics (request count, in-flight gauge, latency histogram).

**Upsert flow (`POST /ioc`):**
1. Validate with zod.
2. Postgres `INSERT ... ON CONFLICT (type, value) DO UPDATE`.
3. **Invalidate** (or overwrite) `cache[type:value]` so reads don't serve stale verdicts.

---

## 2. API surface (from the brief)

| Endpoint | Purpose | Notes |
|---|---|---|
| `POST /lookup` | verdict `malicious`/`unknown` | read-through cache; ioc object present iff malicious; **read tier** (analyst) |
| `POST /ioc` | admin upsert | 201; invalidates cache; **privileged write tier — MUST be authed** (see §S1) |
| `GET /healthz` | liveness | 200 if process up — **process-only, NEVER checks deps** (else a dep blip → restart storm) (§O3) |
| `GET /readyz` | readiness | **Postgres reachable = hard dep; Redis = soft (fail-open, not readiness-gating)** — see §O3 for the SPOF fix + brief-tension note |
| `GET /metrics` | Prometheus exposition | RPS, in-flight, latency histogram, cache hit/miss — **type/verdict labels only, never IOC value** (§S8) |

> **Trust tiers differ:** `/lookup` = read (analysts), `/ioc` = privileged write (admin). Different authz.
> See **§S — Security-by-design** for the full posture; validation is deep + per-type (§S3).

---

## 3. Data model + cache

**Postgres**
```sql
CREATE TABLE ioc (
  type       text  NOT NULL,          -- 'ip' | 'domain' | 'sha256'
  value      text  NOT NULL,
  source     text  NOT NULL,
  score      int   NOT NULL CHECK (score BETWEEN 0 AND 100),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (type, value)           -- upsert + point lookup
);
```
- Connection **pool** (`pg.Pool`), sized deliberately — pool exhaustion under storm is a real
  latency source and part of the "why latency spikes" story.
- Least-privilege app DB user (`SELECT/INSERT/UPDATE` on `ioc` only, not superuser) — §S2.
- **Normalize/canonicalize `value` before storing AND before building the cache key** (lowercase
  domains + hashes, normalize IPs) — so `EVIL.COM` and `evil.com` map to one row/key. This is a
  **security control** (prevents case-variation evasion + cache-key explosion), not just tidiness (§S3).

**Redis (read-through)**
- Key: `ioc:{type}:{value}` → serialized verdict (or a negative-cache marker for `unknown`).
- TTL: e.g. 300s (justify: freshness vs hit-rate; short enough that upserts propagate even if an
  invalidation is missed).
- **Negative caching** of `unknown` matters: SOC alert storms are read-heavy on *misses* too, so
  cache "unknown" to keep Postgres off the hot path. (Guard against unbounded key growth.)
- **Bloom filter (parked → "future work"):** a pre-cache membership check gives "definitely not
  malicious" (fast, no false negatives) vs "maybe — go check". Optimizes the same `unknown` fast-path
  as negative-caching; only pays off at very large IOC-set scale (millions). Over-engineering for a
  2–3 day build, but a strong "with another week" item — it signals awareness of the scaling ladder.

---

## 4. The autoscaling thesis (the heart of the assignment)

### 4a. Why CPU-based HPA is wrong here (challenge #1 — needs *measured* evidence)
- Service is **cache-friendly + I/O-bound**: a request costs almost no CPU; it *awaits* Redis, or
  Postgres on a miss.
- Node runs JS **single-threaded**. Under a 10× alert storm, requests queue on I/O and
  connection-pool contention → **p99 climbs to 2–3s from queueing, not CPU work**.
- CPU utilization therefore stays **well under 70%**, so the HPA trigger never fires. CPU is blind
  to the real bottleneck.
- **Evidence to capture:** Grafana panel over a k6 spike showing **CPU flat (~30–40%) while RPS and
  p99 spike together**, and the CPU-HPA replica count staying at min. That screenshot *is* the
  answer.

### 4b. The better signal
- **Primary: RPS per pod** — leading indicator, proportional to load, stable.
- **Do NOT scale on p99 latency directly** — lagging, noisy, oscillation-prone. Latency is the
  **SLO we protect**, not the knob we turn.
- **Set the target empirically:** load a *single* pod (autocannon/k6), find the RPS where p99 ≈
  150ms, set the KEDA target to **~70–80% of that**. Defensible min/max + threshold, backed by data.
- (Alternative signal noted for the writeup: in-flight concurrency — closer to the queueing cause;
  RPS chosen for stability + simplicity.)

### 4d. Defending min/max replicas (there is NO given RPS — the defense is method, not a magic number)
The take-home is **fully self-contained**: *we* build the load generator (k6); there is no "their
load" and no integration with StrongKeep systems. The only integration surface is the **API
contract** (`/lookup`, `/ioc` shapes). "Verify" = our k6 drives our service on our kind cluster and
we show replicas climb, p99 holds < 200ms, then scale back to **2** (§O4). So max is
defended by **stating an assumption + showing the arithmetic**:
1. **Measure per-pod capacity** (the one hard number): single-pod k6 → RPS where p99 ≈ 200ms (e.g. ~400 RPS/pod).
2. **State an assumed peak + justify:** pick a baseline RPS (mid-size SOC), apply the brief's ~10× storm → peak ≈ 10× baseline.
3. **Divide with headroom:** `max = ceil(peak_RPS / per_pod_capacity × safety_factor)`.
- **min = 2 (shipped)** — sized by baseline load; matches the walkthrough's "return to 2" and satisfies
  `PDB minAvailable >= 2`. **min = 3 is the documented *production* floor** (drain headroom) — knowledge for
  the challenge-#3 defense, NOT the shipped value (§O4).

> **⚠ Deliberate min choice — the challenge-#3 "defend your min" payoff.** Ship **min=2** with
> `PDB minAvailable=2`: this matches the walkthrough's return-to-2 and the spec literally, and the demo
> shows **2 → N → 2**. The catch to *name proactively*: `min == PDB.minAvailable` is a **zero
> voluntary-disruption budget** — a node drain / cluster-autoscaler scale-in (eviction API) would deadlock.
> It does **not** affect the demo: HPA scale-down and rolling updates delete pods *directly* (not via
> eviction), so they work fine at 2 (§O4). **In production I'd floor at min=3** for one pod of drain
> headroom (node upgrades don't hang), keeping minAvailable=2. So: **2 for the demo + literal spec, 3 as
> the operable prod floor** — a deliberate, documented choice. Annotate the manifest loudly so it reads as
> intentional, not as the classic min==minAvailable mistake.

### 4e. The downstream ceiling on max (the sophisticated cap — protects the shared DB)
Max replicas is the **lower of**: (a) the load-derived need from §4d, and (b) the point where pod
count exhausts Postgres. Each pod holds a `pg.Pool` (say 10 conns); N pods = 10N connections — past
some N, **Postgres saturates and adding pods makes p99 worse, not better**. Autoscaling the
stateless tier cannot rescue a saturated shared backend, so max is **deliberately capped to protect
the database** (and/or fronted by a pooler like PgBouncer if we needed to go higher). State this
explicitly in the writeup — it shows autoscaling has a downstream limit.

### 4c. KEDA ScaledObject (shape)
> **Query = TOTAL, threshold = per-pod. Do NOT divide by pod count in the query.**
> KEDA's Prometheus scaler defaults to `metricType: AverageValue`, where the HPA computes
> `desiredReplicas = ceil(queryResult / threshold)` — there is no `currentReplicas` term, so the
> threshold already does the per-pod normalization. Pre-dividing by replica count normalizes *twice*
> and **oscillates**: e.g. total=800, threshold=100 → N=2 gives query=400→desired=4; N=4 gives
> query=200→desired=2; N=2 again → flaps forever. Because incoming RPS is client-driven (not
> capacity-driven), the *total* is stable as N changes → the correct, non-oscillating signal.
> Also: filter to `route="/lookup"` so constant probe/scrape traffic (`/readyz`,`/healthz`,`/metrics`)
> doesn't inflate the signal. (And `kube_pod_info` isn't available — no kube-state-metrics in the minimal stack.)

```yaml
triggers:
- type: prometheus
  metricType: AverageValue          # explicit: makes the TOTAL-query correct (HPA divides by threshold)
  metadata:
    serverAddress: http://prometheus.monitoring.svc:9090
    query: sum(rate(http_requests_total{namespace="iocheck", route="/lookup"}[1m]))  # TOTAL lookup RPS
    threshold: "<empirical per-pod RPS>"   # desired = ceil(total / threshold)
minReplicaCount: 2          # SHIPPED=2: matches walkthrough "return to 2" + spec minAvailable>=2.
                            #   NOTE (challenge #3): min==PDB.minAvailable = zero *eviction* disruption
                            #   budget; harmless for demo (scale-down/rollouts aren't eviction-gated),
                            #   but in PROD floor at 3 for node-drain headroom (§O4).
maxReplicaCount: 10         # defend: min(load-derived need, DB-connection ceiling §4e)
fallback:                   # challenge extra: what if Prometheus is down?
  failureThreshold: 3
  replicas: 4               # metric-source-down state — SEPARATE from baseline min (§O4)
advanced:
  horizontalPodAutoscalerConfig:
    behavior:
      scaleUp:   { stabilizationWindowSeconds: 0 }    # react fast to storms
      scaleDown: { stabilizationWindowSeconds: 300 }  # drain slow, avoid flapping
```
**Deployment strategy (pairs with the PDB):** `rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }` —
surge a new pod up before removing an old one, so a rollout never dips below `PDB minAvailable: 2`
(§O4). Reactive scaling alone can't hold p99 at spike *onset* — cache + headroom do (§O1).

---

## 5. Kubernetes resources (required checklist)

- [ ] **Deployment** — iocheck, `replicas: 2` baseline (§O4; prod-floor 3 documented), `rollingUpdate: maxUnavailable:0 / maxSurge:1`
- [ ] **Service** — ClusterIP fronting the pods
- [ ] **Graceful shutdown** — SIGTERM handler + preStop sleep + drain + pool close, `terminationGracePeriodSeconds: 30` (§O2)
- [ ] **topologySpreadConstraints / anti-affinity** + **multi-node kind** — so HA is real, not theater (§O5)
- [ ] **Postgres** — StatefulSet + PVC (or Deployment + PVC for the take-home)
- [ ] **Redis** — Deployment (ephemeral cache; no persistence needed)
- [ ] **Probes on iocheck** — startup (slow first-load grace) / liveness (`/healthz`, **process-only, no deps**) /
      readiness (`/readyz` → **Postgres hard-dep; Redis soft/fail-open**, §O3)
- [ ] **PodDisruptionBudget** — `minAvailable: 2` (shipped replicas=2 → zero *eviction* budget; safe for demo, prod-floor 3 documented §O4). **Annotate the manifest loudly.**
- [ ] **Resource requests + limits** on *every* container (CPU limit ~1 core/pod shapes the CPU story)
- [ ] **KEDA ScaledObject** — RPS/pod trigger + fallback + scale-down window
- [ ] metrics-server (install w/ `--kubelet-insecure-tls`) — needed to demo the CPU-HPA baseline
- [ ] Prometheus + Grafana (kube-prometheus-stack or minimal) + KEDA
- [ ] **securityContext hardening** on every pod (runAsNonRoot, readOnlyRootFilesystem, drop ALL caps, no-priv-esc, seccomp) — §S4
- [ ] **NetworkPolicy** default-deny + allow-list — §S5 (⚠ requires Calico/Cilium; kindnet won't enforce)
- [ ] **Secrets** via `secretKeyRef` (DB/Redis creds, API key) — never in image/git — §S2
- [ ] **Dedicated least-privilege ServiceAccount**, `automountServiceAccountToken: false`, PSA=`restricted` — §S4

---

## 6. Load testing (challenge #4 — reproducible)

- **k6 script** with `stages`: baseline RPS → **10× spike (alert storm)** → hold → ramp down.
- `thresholds`: `http_req_duration: p(99)<200` → machine-checked pass/fail.
- Drives many connections/VUs so load spreads across pods (also exposes the keep-alive trap).
- Optional **autocannon** one-liner for single-pod calibration (RPS→p99 curve → KEDA target).

---

## 6a. M5 evidence pitfalls (the trickiest milestone — a wrong setup produces a *misleading* demo)

Build M5 against this checklist. Grouped by what each threatens.

**A. Signal integrity — does the thesis actually hold?**
1. **CPU-request ↔ I/O-bound load must align.** Measurable test: **CPU util (usage÷request) stays < 70%** under the storm, else the CPU-HPA *would* fire and the thesis inverts. Verify empirically.
2. **Concurrency-bound, not throughput-bound.** The latency spike is requests **queueing on the PG pool while CPU idles on I/O wait**. Drive **high in-flight concurrency (many VUs)**, not just high RPS. High-concurrency + low-CPU + high-latency is the target shape (achievable *because* I/O-bound).
3. **The PG pool is the bottleneck knob — and there's a cliff.** Pool = 10/pod; saturate it (queue → latency) **without mass-erroring**. `connectionTimeoutMillis: 3000` → a waiter >3s becomes a **500, not latency**. Narrow band: too little = no spike, too much = errors. May need to **raise the pool connection timeout** so p99 climbs to 2–3s cleanly. *(Prep: make pool timeout env-configurable.)*
4. **No CFS throttling — CPU must stay under the LIMIT, not just the request.** Confirm `rate(container_cpu_cfs_throttled_seconds_total{namespace="iocheck"}[1m]) ≈ 0` during the storm. Two reasons: (a) throttling *itself* injects latency → would confound "latency is from I/O"; (b) **zero throttling is positive evidence** the app is never CPU-starved → it strengthens "CPU is not the bottleneck." Staying < 70m (the HPA trigger) is already ~7× under the 500m limit, so it should hold — but *verify it*, don't assume. (Operationalizes §O7.)

**B. Load design (k6)**
5. **Many DISTINCT unknown values** → cache misses → PG load (negative cache can't absorb them).
6. **Uniqueness must outpace the negative-cache TTL (60s)** — repeats within the window become fast negative-hits and dilute the miss load. Use random-over-huge-space or a monotonic counter.
7. **Keep-alive pinning (challenge #2 trap)** — too few connections pin to a couple of pods → skewed per-pod load → distorted signal + failed "pods share load". Use **many connections**; **verify even per-pod RPS** in Grafana.
8. **Hold the spike long enough** — must outlast metrics-server (15s) + HPA sync and read convincingly (sustain ~2–3 min).
9. **Run k6 in-cluster against the Service** (NOT port-forward → single-pod, bypasses LB), in its **own namespace** (avoid restricted-PSS friction), target the Service FQDN. NetworkPolicy already allows `:3000`.

**C. Environment / measurement (laptop reality)**
10. **Shared host CPU can confound everything.** k6 + app + PG + Redis + Prom + Grafana on one machine → too much load saturates the **host**, so "CPU low" turns ambiguous. Keep load **moderate — just enough to saturate the app pool**; give k6 its own resource budget; interpret CPU with host contention in mind. *(Biggest threat to a clean reading.)*
11. **metrics-server 15s resolution + HPA smoothing** — HPA CPU% lags the real curve; the spike must clearly outlast it.

**D. Faithful baseline + evidence**
12. **Replicate the team's actual failed config** for the baseline: **CPU target 70%, min=2, max=8** — showing *their* setup not scaling, not a strawman.
13. **Distinguish "CPU genuinely low" from "metrics broken."** Show the HPA reporting a **real CPU% (e.g. `18%/70%`)** but below threshold — never `<unknown>`.
14. **Only ONE autoscaler at a time.** The M5 CPU-HPA and the M6 KEDA ScaledObject both target the same Deployment → two controllers fight. **Delete the CPU-HPA before applying KEDA.**
15. **No OOM-kills / pod restarts mid-run — else the evidence is contaminated.** A restart during capture = a spurious replica change, restart-induced latency, and a cold cache polluting the numbers. Ensure the mem limit (256Mi) is adequate under load (watch `container_memory_working_set_bytes` vs limit); **verify `RESTARTS=0` + no `OOMKilled`** (`kubectl get pods`, `describe`) before trusting a run — re-run if any pod restarted.
16. **Capture aligned, reproducible evidence** — CPU/RPS/p99/replicas over the *same* window + `kubectl get hpa`, driven by a **scripted run** (repeatable for the call); note run-to-run variance.

**Synthesis (the call sentence):** *drive high concurrency of distinct cache-miss lookups → requests queue on the PG pool → p99 breaches 200ms while CPU stays < 70% of request → the team's own CPU-HPA (70%, min 2/max 8) sits at ~18%/70%, replicas pinned at 2. That's the proof CPU is the wrong signal.*

---

## 6b. M6 build plan & pitfalls (KEDA — the resolution)

**Goal:** replace the CPU-HPA with a KEDA RPS-per-pod ScaledObject; re-run the SAME storm; show it
**scale 2→N→2** (challenges #3/#4) and load spread to the *new* pods (#2).

**p99 vs the 700ms floor — DECISION (locked):** the 700ms modeled store latency is a **hard p99 floor**
(every miss ≥700ms; scaling removes *queueing*, never the service time). So `p99<200ms` and the 700ms
all-miss storm are **mutually exclusive**. **Keep 700ms** (fixed service property; identical to M5 → clean
A/B) and **LIFT the `<200ms` *target*** for the storm demo. **M6 success = scales 2→N→2 + p99 collapses
~5s→~1s** (queueing removed), *not* <200ms. The `<200ms` SLO is met honestly by the **cache** (hits <200ms;
700ms is the cold-upstream floor caching exists to avoid; the all-miss storm is a deliberate worst case) —
state this in REPORT; optional cache-friendly mini-demo to tick the box explicitly.

**Manifest:** `k8s/manifests/70-keda-scaledobject.yaml` (metricType AverageValue, `serverAddress` = prometheus
svc, min 2 / max 8, `fallback`, scale-down window). Requires KEDA installed first (`make observability`/`make keda`).
> **Signal — RPS → CONCURRENCY (empirical, 2026-07-31).** Built RPS-per-pod per §4c first; **it did not
> scale** (`logs/M6-keda-scaling.log`): completed-RPS is capacity-coupled — the pool pins it to ~12/pod =
> the threshold, so KEDA reads "at target" and holds at 2 even at p99=5s. Same storm: in-flight/pod ~40 vs
> RPS/pod ~12. **Switched the trigger to in-flight concurrency** `avg_over_time(sum(http_in_flight_requests
> {namespace="iocheck"})[30s:5s])`, threshold ~10/pod → clean 2→6→2. RPS kept as a "why not RPS" writeup point.

**Pitfalls / conditions:**
1. **Scale-down is deliberately slow** — `scaleDown stabilizationWindowSeconds` (+ KEDA cooldown) delays
   "return to 2" ~5 min. Use **~60–120s for the demo** (note prod uses longer to prevent flapping).
2. **⚠ Keep-alive pins load to the OLD pods on scale-up** — kube-proxy doesn't rebalance *existing*
   connections → **new pods get zero traffic** → p99 doesn't improve, scale-up looks pointless (the
   challenge-#2 trap, worse here). **Fix: k6 must churn connections** (bounded connection lifetime /
   periodic reconnect). Must-do or the demo fails.
3. **RPS is capacity-coupled** — completed-RPS is pool-suppressed at low replicas and *rises* as pods are
   added → the scaler chases equilibrium / may run to max. Calibrate threshold; writeup note (in-flight
   concurrency is a purer leading signal — future work).
4. **Delete the CPU-HPA first** (§6a#14) — two controllers on one Deployment fight.
5. **Scale-up reaction lag** — KEDA poll (30s default) + HPA sync + schedule + startup-probe readiness
   (~30s) ≈ ~1 min → storm onset breaches before scaling helps (§O1, expected/honest). Lower
   `pollingInterval` (~10–15s) to tighten.
6. **DB connection ceiling at max** — 8 pods × pool 10 = 80 < PG 100 (§O8). Safe; don't raise max without PgBouncer.
7. **Fallback demo** — the "autoscaler data source down" deliverable: stop Prometheus → KEDA `fallback`
   holds a safe replica count. Quick capture.

---

## 7. The four challenges → where each is answered

| # | Challenge | Where |
|---|---|---|
| 1 | Why CPU HPA is wrong (measured) | §4a + Grafana "CPU flat / RPS+p99 spike" panel |
| 2 | Make pods share load | k6 many-connections + **keep-alive pinning** fix; show even per-pod RPS |
| 3 | Autoscaler up *and* down, defend min/max | §4c KEDA (scale-up fast, scale-down windowed); **ship min=2** (matches spec/walkthrough) + defend via the eviction/PDB "prod-floor 3" story (§O4); max=capacity math (§4e/§O8) |
| 4 | Prove it with a reproducible test | §6 k6 script + Makefile target; demo **2→N→2** (matches walkthrough's "return to 2") |

### Challenge #2 deep note (the hidden trap)
HTTP **keep-alive can pin many requests to one TCP connection → one pod**, starving others and
making averaged metrics look low. Mitigate/demonstrate: load with many connections; optionally
disable keep-alive or cap connection reuse; show per-pod RPS is even in Grafana. This is a likely
call-time probe.

---

## §S. Security-by-design (this is a threat-intel service, not a generic web app)

**Threat model — three things to protect (every control maps to one):**
- **Integrity** of the intel — tampering via `/ioc`.
- **Confidentiality** of IOCs *and investigation patterns* (what an analyst looks up reveals an active incident).
- **Availability** under alert-storm *and* abuse.

Tags: **[build]** = do in the 2–3 days · **[writeup]** = name as production posture (don't over-build).

### S1. API authentication & authorization
- **[build]** `/ioc` (privileged write) behind **API-key middleware** (`X-API-Key`/bearer vs a secret). `/lookup` = read tier. Different trust tiers → different authz.
- **[writeup]** production path: **JWT** (`jsonwebtoken` + `express-jwt`) or `passport-jwt` with **role/scope claims** (only `admin` scope upserts); OIDC/mTLS at ingress; authenticate `/lookup` too for analyst-level audit.
- **[build]** never log the key/token; constant-time compare.

### S2. Secrets & datastore auth
- **[build]** Postgres password auth (not `trust`) + **least-privilege app user** (`SELECT/INSERT/UPDATE` on `ioc` only). Redis `requirepass`/ACL.
- **[build]** creds + API key in **k8s Secrets** via `secretKeyRef`; `.env` gitignored; **never baked into the image**.
- **[writeup]** base64 ≠ encryption → etcd **encryption-at-rest**; **External Secrets Operator / Sealed Secrets / Vault** so nothing secret is committed; TLS in-transit to both stores.

### S3. Deep, per-type input validation (a security control)
- **[build]** zod refinements: `ip` → `.ip()` (v4/v6 parse); `sha256` → `/^[a-f0-9]{64}$/i` (exactly 64 hex); `domain` → hostname rules (≤253, labels ≤63, no scheme).
- **[build]** cap `value` (~512) + `source` length; `.strict()` (reject unknown fields); **express body-size limit** (`{ limit: '8kb' }`) — oversized-body DoS.
- **[build]** **normalize/canonicalize before store + cache-key** (lowercase domain/hash, normalize IP) → prevents **case-variation evasion** + cache-key explosion. (SQLi handled by parameterized queries regardless.)

### S4. Container / pod hardening
- **[build]** `securityContext` on every pod: `runAsNonRoot: true`, `runAsUser: 1000`, `readOnlyRootFilesystem: true` (+ emptyDir `/tmp`), `allowPrivilegeEscalation: false`, `privileged: false`, `capabilities.drop: ["ALL"]`, `seccompProfile: RuntimeDefault`.
- **[build]** dedicated least-privilege **ServiceAccount** (not `default`); `automountServiceAccountToken: false` (service never calls the k8s API); `hostNetwork/hostPID/hostIPC: false`; no `hostPath`.
- **[build]** namespace **Pod Security Admission = `restricted`**.
- **[build]** Dockerfile: multi-stage, **distroless/alpine**, `USER` non-root, pin base by digest, `.dockerignore`; **[build]** image scan (trivy/grype).
- Resource limits (§5) double as resource-exhaustion-DoS protection.

### S5. Network segmentation ⚠ kind gotcha
- **[build]** **default-deny** ingress+egress in the namespace, then allow-list:
  - Postgres:5432 / Redis:6379 accept ingress **only from iocheck pods** (podSelector).
  - iocheck egress → Postgres, Redis; **allow DNS egress (kube-dns :53)** (the forgotten rule).
  - ingress to iocheck only from ingress controller + Prometheus (scrape).
- **⚠ [build] kind's default CNI (kindnet) does NOT enforce NetworkPolicy** — install **Calico/Cilium** on the kind cluster or the policies are silent no-ops. Affects the clean-spin-up Makefile.

### S6. Threat-intel integrity (why `/ioc` auth is critical, not routine)
The upsert path is the crown jewels. An attacker who writes to `/ioc` can **un-flag a real threat** (`malicious→unknown` = evasion) or **flag a legit IP/domain malicious** (false-positive DoS on the SOC). So `/ioc` auth + audit protects the **integrity of intelligence the whole SOC trusts** — a domain-security control, not CRUD hygiene. **[writeup]** provenance/source tracking + change history.

### S7. Audit logging
- **[build]** structured audit log on `/ioc` (who upserted which IOC, when). **[writeup]** analyst-query audit (queries are sensitive — they reveal active investigations) + retention + tamper-evidence. No secrets/tokens in logs.

### S8. Metrics cardinality & leakage (security + ops)
- **[build]** label metrics by **`type` + `verdict` only — NEVER the IOC `value`/IP/hash**: high-cardinality label = Prometheus OOM (cardinality bomb) *and* leaks sensitive IOCs via `/metrics`.

### S9. Rate limiting / abuse (mind the storm interaction)
- **[build/writeup]** `express-rate-limit` **per identity**, set **above** legit 10× storm levels so a real alert storm is never throttled while a runaway/compromised credential is caught. Explicitly note the interaction with autoscaling (two controls, same traffic).

### S10. Confidentiality, error hygiene, supply chain
- **[writeup]** TLS in transit; Postgres encryption-at-rest (IOCs are confidential).
- **[build]** generic 400/500 to clients — **never leak stack traces / DB errors** (info disclosure).
- **[build]** minimal deps ("defend every dependency"), lockfile, `npm audit`; **[writeup]** SBOM.

---

## §O. Operational readiness (SRE / DevOps)

The plan was infra- and security-complete but thin on *running it on-call*. Same **[build]** / **[writeup]** tags.

### O1. SLO as a window + Time-To-Recover (reactive scaling can't hold the onset)
- **[build]** State the SLO as **windowed with an error budget** — "99% of requests <200ms over a rolling window" — NOT "<200ms at every instant." Purely reactive autoscaling *cannot* hold p99 at spike **onset**: `scrape (15–30s) + KEDA poll (~30s) + HPA sync + schedule + warmup` = tens of seconds; existing pods saturate meanwhile → a brief breach that **burns error budget**, not necessarily an SLO violation.
- **[build]** **What actually holds the onset (not autoscaling):** (1) **the cache** — storms re-query the same IOCs → high hit-ratio → Redis absorbs the burst; (2) **headroom** — scaling at ~70–80% of per-pod capacity leaves slack while new pods come up. Autoscaling handles the *sustained* tail.
- **[build]** **Measure TTR** (seconds from onset until p99 back <200ms) as the scaling-responsiveness SLI; put it on Grafana.
- **[build]** Tighten the loop (scrape + KEDA poll → 5–10s) to shrink the gap (trade: Prometheus load + flap risk). **[writeup]** predictive/cron pre-scaling if storms are schedulable.

### O2. Graceful shutdown / connection draining (scale-down + rollouts mean constant SIGTERM)
Node's default SIGTERM = **immediate exit** → dropped in-flight requests. **Correct k8s ordering — the
preStop hook runs to completion BEFORE the kubelet sends SIGTERM** (not after):
```
Pod deleted → Terminating:
  • k8s removes the pod from Service endpoints (async; kube-proxy iptables propagation takes time)
  • preStop hook runs FIRST: sleep ~5–10s
        (the app KEEPS SERVING NORMALLY here — the sleep buys time for the endpoint removal to
         propagate across nodes, so no NEW traffic is routed to us by the time we shut down)
  • THEN SIGTERM → app handler: server.close() (stop accepting) → drain in-flight
        → pool.end() + redis.quit() → exit
  • not exited within terminationGracePeriodSeconds: 30 ? → SIGKILL
```
- **[build]** explicit SIGTERM handler in the app (Node won't drain for you); `terminationGracePeriodSeconds: 30`
  must cover **preStop sleep + drain time**. The preStop sleep is the classic endpoint-propagation-race fix;
  the readiness flip is redundant here because k8s auto-removes a Terminating pod from endpoints.

### O3. Graceful degradation — hard vs soft deps (Redis must NOT be a SPOF)
- **Problem:** if `/readyz` fails when Redis is down, **all pods flip NotReady at once → Service has zero endpoints → total outage**, though PG + app logic are fine. A self-inflicted correlated-failure outage.
- **[build] Fix — classify deps:** **Postgres = hard** (source of truth) → readyz fails if PG down. **Redis = soft** (cache) → Redis down does **not** gate readiness; instead **fail open**: bypass cache → query PG → expose `cache_up=0` metric + alert → accept higher latency.
- **[build] Recommended:** `/readyz` gates on **Postgres only**; Redis reachability surfaced via `/metrics`.
- **⚠ Brief tension:** README says readyz checks "DB **and cache**." Honor the deliverable but **document the deliberate deviation** (or make it configurable) with this SPOF reasoning — a prime "defend your design vs the spec" moment.
- **[build] Comes with fail-open:** **cache-stampede / thundering-herd** protection when Redis dies or a hot key expires (all requests hit PG at once) → **request coalescing (singleflight)** + **jittered TTLs** + **tight Redis timeouts** (fail-open fast, don't block on slow Redis).
- **[build] Principle:** **liveness (`/healthz`) is process-only, NEVER checks deps** — else a dep blip restarts every pod (restart storm). Readiness removes from LB (safe); liveness restarts (dangerous).

### O4. PDB semantics — `minAvailable == replicas` = zero *eviction* disruption budget (ship 2, prod-floor 3)
- **Precise mechanism (only the eviction API honors PDBs):**

  | Operation | Pod removal path | PDB-gated? |
  |---|---|---|
  | KEDA/HPA scale-down | controller lowers `spec.replicas` → RS deletes directly | ❌ No |
  | Rolling update | RS deletes per `maxUnavailable`/`maxSurge` — direct | ❌ No |
  | `kubectl drain` / node maintenance | **eviction API** | ✅ **deadlock at min==minAvailable** |
  | Cluster-autoscaler node scale-in | eviction API | ✅ deadlock |
  | Spot/node crash | involuntary — pod just dies | ❌ (not gated) |

- **So the deadlock surface is *only voluntary node-level disruption*** — which the demo never triggers.
  Earlier plan text ("rolling updates stall") was imprecise: rolling updates are governed by
  `maxUnavailable`/`maxSurge`, not the PDB.
- **[build] SHIP min = 2** + PDB minAvailable = 2 — matches the walkthrough's "return to 2" and the spec.
  Safe for the demo because scale-down and rollouts aren't eviction-gated. Keep Deployment
  **`maxUnavailable: 0 / maxSurge: 1`** (protects availability *during deploys*, independent of the PDB).
- **[writeup + challenge #3] PROD floor = 3** — `min == PDB.minAvailable` is a zero *voluntary-disruption*
  budget: a node drain would deadlock. In prod, floor at 3 for one pod of drain headroom (node upgrades
  don't hang), keeping minAvailable=2. Ship 2 (demo/spec), recommend 3 (operability) — annotate the
  manifest loudly so it reads as intentional, not the classic min==minAvailable mistake.
- **[build]** `fallback: replicas: 4` is the **metric-source-down** state — unrelated to baseline min; don't conflate.

### O5. HA that's real, not theater — spreading + multi-node
- **[build]** `topologySpreadConstraints` / podAntiAffinity so the baseline pods don't co-locate on one node (a node loss would otherwise breach the PDB instantly). Run a **multi-node kind cluster** to actually *demonstrate* HA + load-sharing (challenge #2). Single-node kind hides this.

### O6. Observability completeness — golden signals (RED/USE), not just latency+RPS
- **[build]** add **errors** (4xx/5xx rate) and **saturation** (pg-pool utilization, **event-loop lag**, Redis/PG conn counts) + **cache hit-ratio**. Richer than CPU — and reinforces "CPU is the wrong signal" by showing saturation ≠ CPU.
- **[build/writeup]** SLO **burn-rate alerts** (multi-window); alert when **replicas hit max** (capacity exhaustion) and when **fallback engages** (Prometheus down).

### O7. Resource sizing / CPU-throttling nuance (ties to challenge #1)
- **[build]** aggressive CPU **limits** cause **CFS throttling** → latency tail *even at low average CPU* — both a real perf trap and more evidence CPU is a poor signal. Size requests/limits deliberately; consider **Guaranteed QoS** (requests=limits) so pods aren't evicted under node pressure.

### O8. Connection math bounds max replicas (concretizes §4e)
- **[build]** enforce `max_replicas × pool_size_per_pod < Postgres max_connections − headroom`. This arithmetic *is* the max-replica cap. **[writeup]** PgBouncer to decouple and raise the ceiling.

### O9. Rollout safety, rollback, and chaos-as-evidence
- **[build]** readiness-gated rollout (bad version never takes traffic) + `kubectl rollout undo` fast path + revisionHistory. **[writeup]** canary.
- **[build] Chaos as proof:** during the load test, **kill a pod and kill Redis** to *demonstrate* drain (§O2) + fail-open degradation (§O3). Far stronger evidence than a happy-path run — and directly showcases resilience on the call.

**Locked decisions:** **ship min replicas = 2** (matches walkthrough + spec; prod-floor 3 documented as the challenge-#3 defense) · `/readyz` gates on **Postgres only** (Redis soft/fail-open) · Deployment **`maxUnavailable:0 / maxSurge:1`**.

---

## 8. Deliverables checklist (from the brief)

- [ ] Source + manifests + Dockerfile + **Makefile**
- [ ] **README** — reproduces setup from clean state
- [ ] **Load test tool** — k6 script (runnable by them)
- [ ] **Writeup (~1–2 pp)** — architecture + 4 answers + **(a)** what happens when the autoscaler's
      data source (Prometheus) is down → KEDA `fallback` + **(b)** one thing with another week
      + **security posture** (threat model + key controls from §S — it's a threat-intel service)
- [ ] **AI chat logs** — `docs/transcript.md` (already recording)

---

## 9. Build sequence (milestones)

1. **Service** — Express + zod (deep per-type validation §S3 + normalization), API-key auth on `/ioc` (§S1), prom-client metrics (type/verdict labels only §S8), read-through cache w/ negative-caching, pg pool. Unit-test cache hit/miss/invalidate + validation.
2. **Containerize** — Dockerfile (multi-stage, distroless/alpine, non-root `USER`, §S4), docker-compose for local dev (service + pg + redis, creds via env).
3. **Cluster** — **multi-node** kind up + **Calico/Cilium** (NetworkPolicy enforces §S5), Makefile; manifests: Deployment (replicas=2 shipped, maxUnavailable:0/maxSurge:1) / Service / PDB(minAvailable=2, annotated §O4) / probes (**liveness process-only, readyz=PG-hard/Redis-soft §O3**) / limits + **graceful shutdown (§O2)** + **topology spread (§O5)** + **securityContext (§S4)** + **Secrets (§S2)** + **NetworkPolicy default-deny (§S5)**, Postgres, Redis.
4. **Observability** — Prometheus scrape + Grafana dashboards (latency, RPS, **errors + saturation + cache hit-ratio + TTR** §O1/§O6) + metrics-server + KEDA installed.
5. **Baseline evidence** — CPU-based HPA + k6 spike → capture "CPU flat, no scale, p99 blows past 200ms" → **challenge #1**.
6. **Real autoscaler** — KEDA ScaledObject on RPS/pod, empirical target, up-fast/down-slow + fallback → demo **2→N→2** (matches walkthrough; §O4) → **challenges #3/#4**.
7. **Load-sharing** — prove even per-pod distribution; address keep-alive → **challenge #2**.
8. **Resilience / chaos** — kill a pod + kill Redis under load → demonstrate graceful drain (§O2) + fail-open degradation (§O3); capture as evidence.
9. **Wrap** — writeup, README, Makefile polish, transcript cleanup.

---

## 10. Risks & gotchas (bank these early)

- **kind has no LoadBalancer** → use `port-forward`/NodePort for local access.
- **metrics-server needs `--kubelet-insecure-tls`** on kind, else the CPU baseline won't render.
- **pg pool exhaustion** under storm is itself a latency source — size it, and mention it.
- **Negative-cache growth** — bound `unknown` keys (TTL + maybe max-keys policy).
- **Scale-down flapping** — hence the 300s scale-down stabilization window.
- **KEDA cooldown / polling interval** — tune so the demo shows responsive-but-stable scaling.
- **Metric source down = autoscaler blind** → KEDA `fallback` replicas is the deliberate answer.
- **Max replicas can't exceed downstream capacity** → past some N, pods exhaust Postgres connections
  and p99 worsens; cap max to protect the DB (§4e).
- **No given RPS target** → defend max by measurement + stated assumption + arithmetic (§4d), not a
  magic number; the exercise is self-contained (we build the load, no integration with their systems).

---

## 10a. Future work (writeup "with another week" candidates)

- **Bloom filter** pre-cache fast-path for `unknown` at large IOC-set scale (see §3).
- **PgBouncer / connection pooler** to raise the downstream ceiling on max replicas (see §4e).
- Scale on **in-flight concurrency** in addition to RPS (closer to the queueing cause).
- Multi-source IOC ingestion + scoring/aging of `added_at`.

---

## 11. Open questions / decisions still to make during build

- Exact **maxReplicas** (compute from expected peak RPS ÷ measured per-pod capacity).
- **TTL value** + whether to negative-cache `unknown` (lean yes, bounded).
- Prometheus install: full `kube-prometheus-stack` vs a minimal Prometheus+Grafana (lean minimal for a lighter clean-spin-up).
- Run k6 **in-cluster** (cleanest for reproducibility) vs from host via port-forward.
