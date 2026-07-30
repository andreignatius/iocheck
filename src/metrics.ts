import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics. This is the surface the autoscaler reads (RPS/pod) and the
 * evidence dashboards use (latency, errors, saturation, cache — §O6).
 *
 * CARDINALITY RULE (§S8): never label a metric with an IOC value / IP / hash.
 * That would both explode cardinality (Prometheus OOM) and leak sensitive IOCs
 * via /metrics. We label only by low-cardinality dimensions: route, method,
 * status class, ioc type, verdict, cache result.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// --- traffic + latency (drives the KEDA RPS trigger and the p99 SLO) ---
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['route', 'method', 'status'] as const,
  // Buckets clustered under the 200ms SLO so p95/p99 near the threshold are readable,
  // and extended to 3s/5s so an I/O-bound spike (team saw p99 2-3s) is visible not clipped.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2, 3, 5],
  registers: [registry],
});

// --- saturation (richer than CPU — reinforces "CPU is the wrong signal", §O6) ---
export const httpInFlight = new Gauge({
  name: 'http_in_flight_requests',
  help: 'In-flight HTTP requests (concurrency)',
  registers: [registry],
});

// --- domain signal: verdict distribution, by type only (NO value label, §S8) ---
export const lookupResultsTotal = new Counter({
  name: 'iocheck_lookup_results_total',
  help: 'Lookup results by IOC type and verdict',
  labelNames: ['type', 'verdict'] as const,
  registers: [registry],
});

// --- cache behaviour (hit-ratio + fail-open visibility, §O3/§O6) ---
export const cacheEventsTotal = new Counter({
  name: 'iocheck_cache_events_total',
  help: 'Cache events by result',
  labelNames: ['result'] as const, // hit | miss | negative_hit | bypass
  registers: [registry],
});

export const cacheUp = new Gauge({
  name: 'iocheck_cache_up',
  help: '1 if the cache (Redis) is reachable, 0 if failing open to Postgres (§O3)',
  registers: [registry],
});
