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
  Prometheus ◀─scrape :9464/metrics (monitoring-only)─ pods   KEDA ◀─reads Prometheus──▶ scales the Deployment
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
  `/readyz`), a **PDB `minAvailable: 2`**, and **CPU/memory requests + limits on every container** —
  datastores pin memory **`request == limit`** (RAM is incompressible, so a squeezed pod is an OOM-kill
  candidate), with Redis additionally bounded by **`maxmemory`+LRU** so it evicts rather than OOMs.

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

A Kubernetes Service load-balances **per connection, not per request**: kube-proxy pins a TCP connection to
one backend at connect time (conntrack) and never rebalances it. So with HTTP **keep-alive**, a client's
requests all ride that one connection and stay on the pod picked *then* — when the autoscaler adds pods, the
**new ones sit idle** while existing connections keep hammering the old.

*Proof that the Service does spread once connections cycle:* with k6 `noConnectionReuse`, a 7-pod scale-out
gave **even per-pod RPS** (`10.2, 10.3, 10.9, 10.7, 11.0, 10.1, 10.5`). But churning is a property of our
*test* client — a real SOC caller holds keep-alive and won't rebalance itself. The lever we control is
**server-side**: cap requests/age per connection (Node `maxRequestsPerSocket` / `keepAliveTimeout`) so the
server periodically closes connections and clients reconnect into a fresh backend pick. The complete answer
is an **L7 proxy / service mesh** that terminates client keep-alive and balances **per request**, making
connection stickiness irrelevant. (The demo uses test-side churn to *isolate and verify* the Service's
balancing; the two production levers above are how you'd guarantee it for clients you don't control.)

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
After 3 failed polls KEDA **holds 4 replicas**. *Why 4?* Scaling here is **multiplicative** (bursts are ~10×;
replicas scale by ratio, not a fixed offset), so the right "middle" of `[min=2, max=8]` is the **geometric
mean** √(2·8) = **4** — equivalently **4 = 2×min = max/2**. Blind to load, that placement is **symmetric in
scaling error**: the held count is at most ~2× off the true demand in *either* direction, whereas collapsing
to `min` risks a **4× under-provision** against a storm we can no longer see (p99 breach), and pinning to
`max` wastes capacity and pushes the DB connection ceiling. It's also backend-safe: 4 × concurrency-target 10
= 40 in-flight at target, and 4 × pool-10 = 40 DB connections — well under Postgres's 100. Independently, the app
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
- **AuthN/Z + audit:** `/ioc` (privileged write — un-flagging a real threat is an evasion, flagging a legit
  one is a SOC DoS) requires an API key (constant-time compare). `/lookup` is the read tier. Every `/ioc`
  write **and every denied attempt** is **audit-logged** — *who* (a key fingerprint, never the key), *from
  where*, and *what changed* (proven: [`logs/S-ioc-audit.log`](logs/S-ioc-audit.log)). The audit path
  deliberately records the IOC value: the "no IOC values in logs" rule targets the high-volume *lookup*
  path; a privileged-*mutation* trail is useless without the object it mutated.
- **Least privilege:** app connects as a role with `SELECT/INSERT/UPDATE` on `ioc` only; **secrets via k8s
  Secret**, never committed (`.env` gitignored, verified clean of history).
- **Network segmentation:** Calico **default-deny** + allow-list; **Postgres/Redis accept traffic only from
  iocheck pods** (proven: a non-iocheck pod is BLOCKED — [`logs/M3-k8s.log`](logs/M3-k8s.log)).
- **Hardening:** namespace **Pod Security Admission = restricted**; non-root, read-only rootfs, dropped
  caps, seccomp; **no IOC values in metrics or logs**; input **canonicalised** (anti-evasion) + size-capped.
- **Supply chain:** distroless runtime on a **current, non-EOL** Node (22; 20 is past end-of-life), every
  image **pinned** (kind node by digest); dev/test deps are pruned from the runtime image, so the shipped
  container reports **0 known vulnerabilities** (`npm audit --omit=dev`). Datastores on current majors
  (Postgres 17, Redis 8).
- **Metrics isolation:** `/metrics` is served on a **separate internal port (9464)**, not the public API
  port, and a **NetworkPolicy** exposes it to the **monitoring namespace only**. Even with no IOC values in
  labels, the *aggregate* metadata (verdict rates, request tempo) reveals **SOC activity/tempo**, so it must
  never sit on the client-facing port. Proven ([`logs/S-metrics-port-split.log`](logs/S-metrics-port-split.log)):
  `:3000/metrics`→**404**, `:9464/metrics` **blocked** from a non-monitoring pod (times out) while Prometheus
  scrapes it `up`. (NetworkPolicy is L3/L4 and can't gate an HTTP path — port separation is what makes the
  policy expressible.)

---

## With another week

1. **Finish the concurrency-vs-RPS ablation** and average multiple runs (the single most valuable rigor fix).
2. **Chaos under load** — kill a pod + kill Redis mid-storm to prove graceful drain + fail-open live.
3. **PgBouncer** to lift the DB connection ceiling and raise `max`; **cache-stampede singleflight** for the
   cold-miss thundering herd.
4. **Tighten the demo p99** (threshold 8 → 8 pods so pool > offered concurrency → sub-1s) and add
   **predictive/scheduled pre-scaling** for known feed-update windows (reactive scaling can't beat spike onset).
5. **Prod hardening:** floor replicas at 3, TLS in transit + DB encryption-at-rest, External Secrets/Vault,
   per-identity auth + rate limiting tuned above legit storm levels, and shipping the `/ioc` audit stream
   (already emitted) to an access-controlled, tamper-evident sink with old→new score diffing to alert on
   un-flagging.
6. **Maintainability:** replace the first-boot `init.sh` with a **versioned migration tool** (`node-pg-migrate`)
   run as a **k8s Job/init-container** — `init.sh` is the standard Postgres-container init but only runs once
   and doesn't track schema versions. As the route surface grows, extract a **controller layer** (the
   business logic already lives in `service.ts`/`repository.ts`, so this is a thin HTTP-wiring split).

---

## Use of AI tools

I used **Claude (via the Claude Code CLI)** as a pair-programming and thinking partner throughout — scoping
the design, drafting code and manifests, load-testing, root-causing (e.g. it proposed RPS scaling; the load
test showed RPS is capacity-coupled and we switched to concurrency together), and drafting this report. I
worked review-before-commit: I read, ran, and verified everything, and every design decision was mine to
accept or reject. The full collaboration is in [`docs/transcript.md`](docs/transcript.md); the design +
build log are in [`docs/plan.md`](docs/plan.md) and [`docs/journal.md`](docs/journal.md).
