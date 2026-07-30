# Test evidence

Committed proof of what was run and observed at each milestone. Each `.log` file has a header with
its capture timestamp and a **reproduce** command. Regenerate any of them from a running stack.

| File | Milestone | What it proves |
|---|---|---|
| [M1-unit-tests.log](./M1-unit-tests.log) | M1 | 15 validation/normalization tests pass (incl. IPv6 canonicalization, per-type validity, strict/limits) |
| [M2-stack.log](./M2-stack.log) | M2 | stack (service+pg+redis) all healthy; distroless image size |
| [M2-smoke.log](./M2-smoke.log) | M2 | happy paths, negative cache, normalization (`Evil.COM`→`evil.com`), IPv6 equivalence (`::1`==long form), 401 no-key, 400 bad sha256, value-free metrics |
| [M2-resilience.log](./M2-resilience.log) | M2 | 413 oversized body (§S3); **Redis fail-open + recovery** (§O3) — lookup served from Postgres while Redis down, readyz stays 200 with `cache:false`, `cache_up` flips 0→1 |

Scripts: [`scripts/smoke.sh`](../scripts/smoke.sh), [`scripts/resilience.sh`](../scripts/resilience.sh).
(k6 load-test evidence — the challenge-#1 "CPU flat while RPS/p99 spike" run — lands here at M5/M6.)
