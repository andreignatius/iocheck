# Evidence — Challenge #1 (CPU-HPA is the wrong signal)

Visual evidence for the writeup/walkthrough. Numeric backing is in
[`logs/M5-cpu-hpa-baseline.log`](../../logs/M5-cpu-hpa-baseline.log).

**Run config:** `STORE_LOOKUP_LATENCY_MS=700` (models a slow remote reputation/feed lookup on cache
miss — see REPORT for the honest rationale), k6 `PEAK_VUS=60` cache-miss storm, iocheck `cpu request=200m /
limit=500m`, and the team's own failed autoscaler replicated: **CPU-HPA at 70% utilization, min 2 / max 8**.

> Note: the Grafana CPU panels are scaled to the **200m** request (util = usage ÷ 200m). An earlier
> version hardcoded a 100m request and therefore displayed CPU at 2× — fixed so the panels match the
> real HPA reading.

## Screenshots

### `challenge1-overview.png` — the 4-panel overview
Two storm humps. Reading across the same time window:
- **RPS** peaks ~28 lookup req/s (throughput is *capped* by the saturated pool — the tell of an I/O bottleneck).
- **p99 latency** spikes to **~3–5s** (15–24× the 200ms SLO line).
- **CPU per pod** stays **under the 140m trigger line** (70% of the 200m request).
- **Replicas** stay **flat at 2** through both storm peaks (22:23, 22:27) — the CPU-HPA never scaled.
  (The brief single blip to 3 at ~22:21 is the **rolling-update surge** — `maxSurge:1` — from the
  config redeploy just before the run, *not* the autoscaler.)

### `challenge1-cpu-vs-p99.png` — the money-shot (dual-axis overlay)
The single panel that makes the argument: **CPU % of request hugs ~25–55%, peaking just under 60% (well under the 70% HPA
trigger line) while p99 blows past the SLO to seconds.** A CPU-based HPA sees "plenty of CPU headroom,
nothing to do" — and never scales — while the service is drowning. **CPU is blind to the I/O bottleneck.**

## The one-sentence takeaway
*Under an I/O-bound alert storm, CPU utilisation sits ~10–35% (peaking ~55–59%, still below the 70% trigger) so the team's
CPU-HPA holds replicas at 2, while p99 breaches to ~3–5s with zero errors (pure queueing) and near-zero
CFS throttling — proving CPU is the wrong scaling signal for this workload.*

---

# Evidence — Challenge #3 (the RIGHT signal scales correctly)

Numeric backing: [`logs/M6-keda-concurrency.log`](../../logs/M6-keda-concurrency.log).

**Run config:** same storm as challenge #1, but the CPU-HPA is replaced by the **KEDA ScaledObject scaling
on in-flight concurrency per pod** (`avg_over_time(sum(http_in_flight_requests)[30s:5s])`, AverageValue,
threshold 10/pod, min 2 / max 8). (We first tried RPS-per-pod and found it's *capacity-coupled* — the pool
pins completed-RPS to the threshold under saturation, so it doesn't fire; concurrency reflects the offered
load and does — see journal 2026-07-31.)

### `m6-challenge3-keda-scaling.png` — the M6 money-shot (pair with challenge #1)
(supporting: `m6-overview.png`, `m6-cpu-vs-p99.png`)
The dashboard's bottom panel *"Challenge #3 — KEDA concurrency scaling"* over the storm:
- **replicas** (green) step up **2 → 5 → 6 → 7** as in-flight concurrency climbs, then scale back **7 → 2**
  ~60s after load stops.
- **p99** (orange) **recovers from ~5s toward ~2s** as the added pods drain the queue.
- Per-pod RPS is **even across all 7 pods** (`10.2, 10.3, 10.9, …`) — load reaches the *new* pods (the
  `noConnectionReuse` churn fix; challenge #2).

**The before/after:** challenge #1 = CPU-HPA blind, replicas pinned at 2, p99 5s. Challenge #3 = KEDA on
concurrency, replicas 2→7→2, p99 recovers. Same workload, only the scaling signal changed.

<!-- Save the PNGs into this folder: challenge1-overview.png, challenge1-cpu-vs-p99.png, challenge3-keda-scaling.png -->

