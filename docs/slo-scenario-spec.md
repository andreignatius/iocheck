# SLO scenario spec (DRAFT for review) — cache-friendly, constant-arrival-rate

**Status:** proposed. Not implemented. Andre to review the decisions marked **[DECIDE]**.

## 1. Goal
**Demonstrate** (not assert) that `p99 < 200ms` is met under the stated *read-heavy, cache-friendly*
workload — closing the one un-measured claim in REPORT #4 ("…`p99<200ms` is reachable, but not one I
load-tested…"). This is a **second, complementary** scenario; the existing miss-heavy storm stays as-is.

## 2. Why a second scenario (don't reuse the storm)
| | existing `lookup-storm.js` | this scenario |
|---|---|---|
| executor | `ramping-vus` (**closed** loop) | `constant-arrival-rate` (**open** loop) |
| in-flight | ≈ VUs (latency-independent) | = rate × latency (latency shows up honestly) |
| workload | 100% cache-**miss** (distinct IOCs) | realistic hit/miss **mix** |
| purpose | stress the autoscaler (concurrency) | measure SLO on normal traffic |
| expected | scales 2→N; p99 ≫ 200ms (by design) | **no scaling**; **p99 < 200ms** |

The contrast is the payoff: *the autoscaler is for the storm; the cache is for the SLO.*

## 3. Workload model
- **Hot set:** `H` distinct IOC values, **seeded as MALICIOUS** (via `/ioc`) so a hit returns a *found* verdict
  cached under `CACHE_TTL` (**300s**) — NOT an unknown/negative verdict cached under `NEGATIVE_CACHE_TTL`
  (**60s**). *(Andre's catch — critical:* if the hot set were unknown, each entry would expire every 60s and
  re-incur a 700ms miss mid-run; the run would silently manufacture its own misses and blow the target
  hit-ratio.) **[DECIDE]** `H=200`.
- **Warm-up:** k6 `setup()` upserts the `H` malicious IOCs (needs `IOC_ADMIN_API_KEY` in the Job env) then
  queries each once → all cached before measurement. **Keep total run < 300s** (`CACHE_TTL`) so hot entries
  don't expire mid-run. (Alternative: seed via a `make` pre-step instead of `setup()`, to keep the key out of k6.)
- **Per request:** with prob `HIT_RATIO` → random hot value (**cache hit**, sub-ms Redis GET, 300s TTL); else →
  a **fresh unique** value (**genuine miss** → 700ms store path; negative-cached but never reused, so it stays a miss).
- Tag each request `hit` vs `miss` so we report both latency distributions separately.

> **Aside (real insight worth a line in the writeup):** the 60s negative-TTL means *benign-but-repeated*
> lookups (analysts re-checking known-good indicators) also re-miss every 60s. That's a deliberate tradeoff
> (short negative TTL → newly-flagged IOCs surface fast), but it means the cache-friendly SLO is easiest to
> hold for *malicious-hot* traffic; benign-hot traffic would need a longer negative TTL or the layered fix (#7).

## 4. The critical parameter — store latency `L` vs the 200ms SLO  **[DECIDE]**
Because p99 = the top 1%:
- **Keep `L=700` (recommended, most honest):** the modeled slow store is *unchanged*; the demo just runs a
  hot cache. `p99<200ms` then holds **iff `HIT_RATIO ≥ ~99%`** (misses < 1%, so p99 is still a hit). Report
  the full table: p50–p95 sub-ms (cache working), p99 < 200ms (miss path stays out of the top 1%).
- *Alternative:* lower `L` for this scenario (e.g. 150ms) → even a miss meets the SLO, so it passes at any
  hit-ratio — but that quietly changes the store model and is a weaker claim. **Recommend NOT this.**

**Recommended operating point:** `L=700`, **`HIT_RATIO=0.995`** (Andre — safety margin: at 0.99 the 1% miss
sits *on* the p99 boundary; at 0.995 the misses are the top 0.5%, so p99 is unambiguously a hit with headroom).
**Optional honesty sweep:** `HIT_RATIO ∈ {0.90, 0.99, 0.995}` → shows p99 crossing 200ms below ~99%,
empirically validating the layered-fix argument (why misses must be bounded). ~3 short runs.

## 5. Load level — keep it at baseline capacity (no scaling)  **[DECIDE]**
Pick arrival rate `R` low enough that the 2-replica floor serves it without pool saturation, so the SLO
reflects the **cache at baseline**, not a scaling transient.
- Sanity (Little's Law): in-flight ≈ `R × avg_latency`. At `R=60/s`, `HIT_RATIO=0.995`:
  avg_latency ≈ 0.995·(~1ms) + 0.005·(700ms) ≈ **4.5ms** → in-flight ≈ 0.27 total (~0.14/pod) ≪ threshold 10 →
  **KEDA stays at 2.** Miss pool load: 0.005·60·0.7 ≈ 0.21 connections — trivial.
- **[DECIDE]** default `R=60 req/s`, steady `duration=3m` after warm-up. `preAllocatedVUs≈50`, `maxVUs≈100`.

## 5b. Cache-friendly spike variant (Andre's ask — it behaves *differently* from the storm)  **[DECIDE: include]**
Same hit/miss model, `ramping-arrival-rate`: baseline `R` → **10× burst** (60 → 600/s) → hold → back down.
- **Expected — the cache absorbs it; NO onset breach.** Hits are sub-ms, so even 10× the rate keeps in-flight
  low (`600 × ~4.5ms ≈ 2.7` total, ~1.4/pod ≪ threshold 10) → **KEDA stays at 2**, and no pool saturation
  (misses ≈ 3/s × 700ms ≈ 2 connections ≪ 20) → **no queuing → p99 holds through the burst, including at onset.**
- **The key contrast with the miss-heavy storm:** the storm's spike breaches p99 at onset because it surges
  *concurrency* and reactive scaling lags. A cache-friendly spike has **no concurrency surge to lag behind**,
  so it's a non-event. It also demonstrates the autoscaler's **specificity** — it scales on genuine need
  (miss-heavy) and correctly *ignores* a burst the cache already absorbs (not raw request rate).
- Capture: replicas (expect steady **2**), in-flight (expect low), p99 (expect **< 200ms** through the burst).
- Honesty: pool saturation *would* eventually bite, but only at absurd rates (misses fill 20 conns at ~`R>5700/s`,
  a ~95× spike) — stated so we're not silently assuming it can't happen.

## 6. Pass criterion & what we capture
- k6 threshold (same gate as the storm): `http_req_duration: ['p(99)<200']` → **expected PASS**.
- Capture: full percentile table (p50/p90/p95/p99/max), req rate, **hit vs miss latency split** (tagged
  trends: expect hits ~sub-ms, misses ~700ms), and **replica count over the run = steady 2** (proof it
  met the SLO without scaling). Into `logs/S-slo-cache-friendly.log` (committed evidence).

## 7. Repo integration
- New script `k8s/loadtest/cache-friendly.js` (leave `lookup-storm.js` untouched).
- New Makefile target `make loadtest-slo` (mirrors `loadtest`: configmap the script, run the in-cluster Job).
- Evidence log `logs/S-slo-cache-friendly.log` + a row in `logs/README.md`.
- REPORT #4: replace the "not one I load-tested" hedge with the measured result
  (e.g. "*measured: p99 = Xms < 200ms at 99.5% hits, steady 2 replicas — [`log`]*"), and KEEP the honest note
  that it requires high hit-ratio **or** bounded misses (the sweep shows the crossover). Keeps the layered-fix
  (#7) as the answer for lower hit-ratios.

## 8. Honest caveats to state in the writeup
1. The pass is **conditional on `HIT_RATIO ≥ ~99%` at `L=700`** — not cherry-picking, it's the actual
   condition (a 700ms miss alone > SLO), and it's precisely why the layered fix bounds misses.
2. **Steady-state only.** A sharp 10× spike still breaches p99 at onset (the storm/pre-scaling finding stands).
3. Cost: ~1 short load-test run for the headline (+3 short runs if we do the sweep); host-heavy but far
   lighter than the storm (low concurrency, no scaling).

## 9. Decisions
- [RESOLVED] `L=700` + **`HIT_RATIO=0.995`** (Andre — safety margin).
- [RESOLVED] hot set **seeded malicious** (Andre) — avoids the 60s negative-cache self-contamination.
- [RESOLVED] **include the cache-friendly spike variant** (§5b) (Andre).
- [DECIDE] also run the honesty sweep `{0.90, 0.99, 0.995}`, or headline (0.995) only?
- [DECIDE] numbers OK? steady `R=60/s` 3m, spike `60→600/s`, `H=200`.
- [DECIDE] submission artifact (committed evidence + REPORT update + logs-index row) vs throwaway confidence check?
