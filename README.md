# iocheck — Build & Scale Challenge

Build a small threat-intel lookup service and make it autoscale correctly on Kubernetes.

**Format:** Take Home, 2-3 days

**AI assistance:** unrestricted. Use Claude, ChatGPT, Cursor, Copilot, anything. The follow-up call is where we calibrate — be ready to defend every line, every dependency, and every design choice as if you wrote it from scratch.

**Language:** TypeScript, to align with our existing tech stack.

---

## Background

You're building **iocheck**, a backend service used by SOC analysts to check whether a given **IOC (Indicator of Compromise)** — an IP, domain, or file hash — is known-malicious. IOCs are forensic artifacts: a suspicious IP in a firewall log, a sha256 of a binary on an endpoint, a domain seen in DNS. Analysts query a service like this on every alert.

Real-world equivalents: VirusTotal, AbuseIPDB, GreyNoise. You're building a stripped-down internal version.

### Product context (verbatim from the team)

> *"Our previous attempt added a CPU-based HorizontalPodAutoscaler at 70% utilization with min=2, max=8.*
> *In testing, pods rarely scale up — even when SOC alert storms drive p99 latency to 2-3 seconds.*
> *We need autoscaling that actually responds to the workload this service sees. CPU at 70% is not good enough."*

You should treat this as a hint, not a constraint: a CPU-based HPA at 70% will likely not satisfy the requirements below. Part of the exercise is figuring out *why* and choosing a better signal — with evidence.

---

## Functional requirements

### API

`POST /lookup`

```json
// request
{ "type": "ip" | "domain" | "sha256", "value": "<string>" }
// response 200
{
  "verdict": "malicious" | "unknown",
  "ioc": { "type": "...", "value": "...", "source": "...", "score": 0-100 } // present iff malicious
}
```

`POST /ioc` — admin upsert

```json
// request
{ "type": "...", "value": "...", "source": "...", "score": 0-100 }
// response 201
{ ...same shape... }
```

`GET /healthz` — liveness, returns 200 when process is running
`GET /readyz` — returns 200 only when DB and cache are reachable
`GET /metrics` — Prometheus exposition format

### Storage

- **Persistent store** — your choice (relational, KV, document — whatever fits the access pattern). Schema must let you upsert and look up by `(type, value)` and return `source`, `score`, `added_at`. Justify the choice in your writeup.
- **Cache layer** — your choice. Read-through, sensible TTL, invalidate on upsert.

### Workload

Read-heavy, cache-friendly, bursty (alert storms = ~10× RPS spikes). p99 < 200ms required, including during spikes.

---

## Platform requirements

Run on a local Kubernetes cluster (`kind`, `k3d`, `minikube` — your choice).

You must have:

- Containerized service (Dockerfile)
- k8s manifests (or Helm) for: Deployment, Service, your DB, your cache
- **Liveness, readiness, startup probes** wired correctly
- **PodDisruptionBudget** with `minAvailable >= 2`
- **Resource requests + limits** on every container
- **Horizontal autoscaling** that responds to the actual workload — see below

---

## The four challenges

1. **Explain why CPU-based HPA is wrong for this workload.** Measured evidence, not theory.
2. **Make sure pods share load.**
3. **Build an autoscaler that scales up and down.** You decide min and max replicas — defend the choice.
4. **Prove it works with a reproducible test.**

---

## Deliverables

Send a git URL (public or private invite) containing:

1. **Source + manifests + Dockerfile + a** `Makefile` (or equivalent)
2. **README** — reproduces your setup
3. **Load test tool** — script that we can run to drive load
4. **A writeup** (markdown, ~1-2 pages) — architecture, your answers to all four challenges, plus: what happens when your autoscaler's data source is itself unavailable, and one thing you'd do differently with another week.
5. **AI chat logs** — local transcripts

We'll schedule a 30-min walkthrough call where you'll show us:

- Spinning up the cluster from a clean state
- Driving load and showing replica count climbing
- Stopping load and showing it return to 2
- The actual metric your autoscaler is reading

