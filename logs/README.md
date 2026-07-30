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

Scripts: [`scripts/smoke.sh`](../scripts/smoke.sh), [`scripts/resilience.sh`](../scripts/resilience.sh), [`scripts/k8s-verify.sh`](../scripts/k8s-verify.sh).
(k6 load-test evidence — the challenge-#1 "CPU flat while RPS/p99 spike" run — lands here at M5/M6.)
