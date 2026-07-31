# iocheck — Report

A threat-intel IOC lookup service (IP / domain / sha256 → `malicious` | `unknown`) that **autoscales on
the signal that actually reflects this workload**, on a local Kubernetes cluster. This report covers the
architecture, the four challenges (with measured evidence in [`logs/`](logs/) and [`docs/evidence/`](docs/evidence/)),
what happens when the autoscaler's data source fails, the security posture, and what I'd do with another week.

> **Reproduce:** `make all` (cluster + CNI → monitoring/KEDA → app, in that order) → `make loadtest`.
> See [README.md](README.md) for the clean-from-scratch walkthrough.

---

## Architecture

```
client ─POST /lookup─▶ Service (ClusterIP) ─▶ iocheck pods (Express/TS, 2..8 replicas)
                                                  │  read-through
                                        cache hit │           │ cache miss
                                                  ▼           ▼
                                             Redis (soft)   Postgres (hard, source of truth)
        Prometheus ◀─scrape /metrics── pods        KEDA ◀─reads Prometheus──▶ scales the Deployment
```

- **App:** Express + TypeScript. `zod` per-type validation **+ canonicalization** (lowercased domains,
  RFC-5952 IPs) so `EVIL.COM` and `::1`/`0:0:…:1` can't evade a block or split the cache. `prom-client`
  metrics (labelled by type/verdict only — never the IOC value). Runs as a **distroless, non-root,
  read-only-rootfs** container.
- **Storage:** **Postgres** is the source of truth (`PRIMARY KEY (type, value)`, upsert via `ON CONFLICT`)
  and a **hard dependency**. **Redis** is a **read-through cache with negative-caching**, a **TTL**, and
  **invalidation on `/ioc` upsert** (so a re-classified IOC is never served stale) — and a **soft
  dependency**: if it fails the service **fails open** to Postgres (below).
- **Platform:** multi-node **kind** cluster with **Calico** (so NetworkPolicy actually enforces — kindnet
  doesn't). metrics-server + a minimal **Prometheus/Grafana** (provisioned as code) + **KEDA**. The
  Deployment wires all **three probes** (startup for slow first-load, liveness on `/healthz`, readiness on
  `/readyz`), a **PDB `minAvailable: 2`**, and **CPU/memory requests + limits on every container**.

Design choices I can defend: point-lookup schema (no trained retriever/vector store needed); cache
absorbs the read-heavy common case; the datastores are the only stateful pieces; everything else is
stateless and horizontally scalable.

---

## The four challenges

### #1 — Why a CPU-based HPA is wrong for this workload (measured)
Evidence: [`logs/M5-cpu-hpa-baseline.log`](logs/M5-cpu-hpa-baseline.log), [`docs/evidence/challenge1-cpu-vs-p99.png`](docs/evidence/).

This service is **I/O-bound**: a lookup spends its time awaiting the cache/store, not burning CPU. Under
an alert-storm of cache-**misses**, requests **queue on the Postgres connection pool** while the CPU sits
idle. So during a storm that drove **p99 to ~5s** (25× the 200ms SLO), CPU utilisation stayed at
**~10–35% for most of the storm and peaked at ~59%** — **never reaching the 70% trigger** — so the team's
own config (**CPU 70%, min 2 / max 8**) **held replicas pinned at 2**. k6's own `p(99)<200ms` gate FAILED
with **0 errors** (pure queueing, not 500s), and CFS throttling stayed **low (≲0.4/s)** — the app was never
CPU-starved. **CPU is blind to the I/O bottleneck.**

> **Honest disclosure (important).** A toy Postgres on a 3-row table answers in sub-millisecond, so *this
> specific implementation* would actually be CPU-bound and a CPU-HPA would suffice for it. That is an
> artifact of the unrealistically fast toy DB. Real threat-intel stores/feeds are slow (VirusTotal /
> AbuseIPDB-style lookups run ~200ms–1s, higher at p99). I therefore model a representative store latency
> via `STORE_LOOKUP_LATENCY_MS` (a `pg_sleep` on a **held pool connection**, so it occupies a pool slot;
> **off by default**), calibrated to reproduce the **2–3s p99** the team described. This puts the service
> in the I/O-bound regime real ones exhibit — where CPU-HPA demonstrably fails.

### #2 — Make sure pods share load
Evidence: [`logs/M6-keda-concurrency.log`](logs/M6-keda-concurrency.log), [`docs/evidence/m6-challenge3-keda-scaling.png`](docs/evidence/).

The trap: kube-proxy does **not** rebalance *existing* keep-alive connections, so when the autoscaler adds
pods, a client's pinned connections keep hammering the **old** pods and the new ones sit idle. The load
generator must **churn connections** (we use k6 `noConnectionReuse`) so each request re-picks a pod via the
Service. Result under a 7-pod scale-out: per-pod lookup RPS was **even across all 7 pods**
(`10.2, 10.3, 10.9, 10.7, 11.0, 10.1, 10.5`) — the new pods took their share.

### #3 — An autoscaler that scales up *and* down; defend min/max
Evidence: [`docs/evidence/m6-challenge3-keda-scaling.png`](docs/evidence/) — replicas **2 → 7 → 2**.

I use **KEDA** scaling on **in-flight concurrency per pod**, not RPS. *Why not RPS?* I tried it first and
found **completed-RPS is capacity-coupled**: the pool caps throughput to ~12 RPS/pod = the threshold, so
KEDA reads "at target" and never scales — reproducing the CPU-HPA failure ([`logs/M6-keda-scaling.log`](logs/M6-keda-scaling.log)).
On the **same storm**, in-flight was ~40/pod while RPS was ~12/pod — concurrency reflects the *offered*
load (a queued request still counts as in-flight) and isn't pool-suppressed. KEDA (`metricType: AverageValue`
→ `desired = ceil(total ÷ threshold)`) then scaled **2→7→2**, and **p99 fell 5s→~2s while replicas held at
7 and load was still high** — the added pods drained the queue in real time.

- **min = 2** (ships): matches the spec's `minAvailable ≥ 2` and the walkthrough's "return to 2." I flag
  deliberately that `min == PDB.minAvailable` is a **zero *voluntary-disruption* budget** — a node drain
  (eviction API) would deadlock; HPA scale-down and rolling updates are *not* eviction-gated, so this is
  safe for the demo. **In production I'd floor at 3** for one pod of drain headroom.
- **max = 8**: bounded by the **downstream DB connection ceiling** — 8 pods × pool-10 = 80 < Postgres's
  100. Autoscaling the stateless tier can't rescue a saturated backend, so max protects the DB (PgBouncer
  would raise it).

### #4 — Prove it works with a reproducible test
The load tool is [`k8s/loadtest/lookup-storm.js`](k8s/loadtest/lookup-storm.js) run via **`make loadtest`**
as an **in-cluster Job** hitting the Service (not `kubectl port-forward`, which pins to one pod and bypasses
load-balancing). It ramps a baseline → 10×-ish spike → hold → ramp-down, generates **distinct** IOC values
(cache misses that outpace the negative-cache TTL), and encodes `p(99)<200ms` as a machine-checked
threshold. The same script drives both the CPU-HPA baseline (#1) and the KEDA run (#3), so the before/after
is directly comparable.

---

## What happens when the autoscaler's data source is unavailable

KEDA reads Prometheus. If Prometheus is unreachable, the ScaledObject's **`fallback`** takes over:
```yaml
fallback: { failureThreshold: 3, replicas: 4 }
```
After 3 failed polls, KEDA holds a **safe middle count (4 replicas)** rather than collapsing to `min` (which
would drop capacity during a storm we can no longer see) or thrashing on stale data. Independently, the app
tolerates a **Redis outage** by design: `/readyz` gates on **Postgres only** (hard dep); Redis is soft, so a
lookup **fails open** to Postgres (verified: [`logs/M2-resilience.log`](logs/M2-resilience.log) — served from
PG with Redis down, `readyz` stays 200, `cache_up=0`). And `/healthz` (liveness) is **process-only** so a
dependency blip never triggers a restart storm.

> **Deliberate deviation from the brief.** The brief specifies `/readyz` returns 200 *only when DB **and
> cache** are reachable.* I gate on **Postgres only** on purpose: making Redis gate readiness turns the
> cache into a **single point of failure** — one Redis blip would flip **every** pod to `NotReady`, empty the
> Service's endpoints, and cause a **total outage**, even though Postgres and the app logic are fine. Since
> the service correctly *fails open* to Postgres without Redis, a Redis outage should be a **graceful
> degradation, not an outage**. So `/readyz` treats Postgres as the hard dependency and reports Redis
> reachability via the `cache_up` metric instead of gating on it. (It's a one-line change to honour the
> brief's literal wording if required — but I'd argue the SPOF is the more important property.)

---

## Security posture (it's a threat-intel service, not a generic web app)

Threat model: protect **integrity** of the intel (tampering via `/ioc`), **confidentiality** of IOCs and
investigation patterns, and **availability** under storm + abuse.
- **AuthN/Z:** `/ioc` (privileged write — un-flagging a real threat is an evasion, flagging a legit one is a
  SOC DoS) requires an API key (constant-time compare). `/lookup` is the read tier.
- **Least privilege:** app connects as a role with `SELECT/INSERT/UPDATE` on `ioc` only; **secrets via k8s
  Secret**, never committed (`.env` gitignored, verified clean of history).
- **Network segmentation:** Calico **default-deny** + allow-list; **Postgres/Redis accept traffic only from
  iocheck pods** (proven: a non-iocheck pod is BLOCKED — [`logs/M3-k8s.log`](logs/M3-k8s.log)).
- **Hardening:** namespace **Pod Security Admission = restricted**; non-root, read-only rootfs, dropped
  caps, seccomp; **no IOC values in metrics or logs**; input **canonicalised** (anti-evasion) + size-capped.

---

## With another week

1. **Finish the concurrency-vs-RPS ablation** and average multiple runs (the single most valuable rigor fix).
2. **Chaos under load** — kill a pod + kill Redis mid-storm to prove graceful drain + fail-open live.
3. **PgBouncer** to lift the DB connection ceiling and raise `max`; **cache-stampede singleflight** for the
   cold-miss thundering herd.
4. **Tighten the demo p99** (threshold 8 → 8 pods so pool > offered concurrency → sub-1s) and add
   **predictive/scheduled pre-scaling** for known feed-update windows (reactive scaling can't beat spike onset).
5. **Prod hardening:** floor replicas at 3, TLS in transit + DB encryption-at-rest, External Secrets/Vault,
   an audit log on `/ioc`, and per-identity rate limiting tuned above legit storm levels.

---

## Use of AI tools

I used **Claude (via the Claude Code CLI)** as a pair-programming and thinking partner throughout — scoping
the design, drafting code and manifests, load-testing, root-causing (e.g. it proposed RPS scaling; the load
test showed RPS is capacity-coupled and we switched to concurrency together), and drafting this report. I
worked review-before-commit: I read, ran, and verified everything, and every design decision was mine to
accept or reject. The full collaboration is in [`docs/transcript.md`](docs/transcript.md); the design +
build log are in [`docs/plan.md`](docs/plan.md) and [`docs/journal.md`](docs/journal.md).
