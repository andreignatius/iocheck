# Test evidence

Committed proof of what was run and observed at each milestone. Each `.log` file has a header with
its capture timestamp and a **reproduce** command. Regenerate any of them from a running stack.

| File | Milestone | What it proves |
|---|---|---|
| [M1-unit-tests.log](./M1-unit-tests.log) | M1 | 15 validation/normalization tests pass (incl. IPv6 canonicalization, per-type validity, strict/limits) |
| [M2-stack.log](./M2-stack.log) | M2 | stack (service+pg+redis) all healthy; distroless image size |
| [M2-smoke.log](./M2-smoke.log) | M2 | happy paths, negative cache, normalization (`Evil.COM`→`evil.com`), IPv6 equivalence (`::1`==long form), 401 no-key, 400 bad sha256, value-free metrics |
| [M2-resilience.log](./M2-resilience.log) | M2 | 413 oversized body (§S3); **Redis fail-open + recovery** (§O3) — lookup served from Postgres while Redis down, readyz stays 200 with `cache:false`, `cache_up` flips 0→1 |
| [M3-k8s.log](./M3-k8s.log) | M3 | deployed to kind: pods **spread across nodes** (§O5), **PDB ALLOWED DISRUPTIONS=0** (§O4), functional endpoints, **NetworkPolicy segmentation** — non-iocheck pod BLOCKED from datastores (§S5) |
| [M4-observability.log](./M4-observability.log) | M4 | metrics-server (`kubectl top`, iocheck idle ~13m), Prometheus scraping iocheck (targets UP), Grafana datasource+dashboard provisioned-as-code, KEDA healthy (external-metrics `Available=True`) |
| [M5-cpu-hpa-baseline.log](./M5-cpu-hpa-baseline.log) | M5 | **challenge #1**: team's CPU-HPA (70%/2/8) under an I/O-bound storm — **CPU util ~10–35% (peak ~59%, still <70%), replicas pinned at 2**, p99 breached to ~3–5s, k6 `p(99)<200` FAILED, 0 errors, throttle low (≲0.4/s), restarts 0 |
| [M6-keda-scaling.log](./M6-keda-scaling.log) | M6 | the **RPS signal fails** run — completed-RPS is pool-capped at ~12/pod = threshold → KEDA holds at 2 (motivates the switch to concurrency) |
| [M6-keda-concurrency.log](./M6-keda-concurrency.log) | M6 | **challenges #2/#3/#4**: KEDA on in-flight concurrency → **2→7→2**, load spread evenly across all pods, p99 ~5s→~2s |
| [M9-clean-spinup.log](./M9-clean-spinup.log) | M9 | **`make cluster-down && make all` from scratch → exit 0**: platform-then-app order, **ScaledObject applies cleanly**, 3 nodes Ready, all pods Running, smoke test passes (the "spin up from clean state" deliverable) |
| [S-metrics-port-split.log](./S-metrics-port-split.log) | §S8 | **/metrics moved off the public port** to an internal, monitoring-only port (9464): `:3000/metrics`→404, `:9464` **blocked from a non-monitoring pod**, Prometheus scrape `up`, KEDA still `Happy` — keeps SOC-activity metadata off the client-facing port |
| [S-ioc-audit.log](./S-ioc-audit.log) | §S7 | **/ioc audit trail**: successful write → `ioc_upsert` (who=key fingerprint, from where, what changed); bad key → `ioc_auth_denied`; raw admin key never appears in logs |

Scripts: [`scripts/smoke.sh`](../scripts/smoke.sh), [`scripts/resilience.sh`](../scripts/resilience.sh), [`scripts/k8s-verify.sh`](../scripts/k8s-verify.sh).
(k6 load-test evidence — the challenge-#1 "CPU flat while RPS/p99 spike" run — lands here at M5/M6.)
