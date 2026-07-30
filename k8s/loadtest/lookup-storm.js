import http from 'k6/http';
import { check } from 'k6';

// Target the Service (not a pod) so kube-proxy load-balances across replicas (§6a#9).
const BASE = __ENV.TARGET || 'http://iocheck.iocheck.svc.cluster.local:3000';
const PEAK = Number(__ENV.PEAK_VUS || 60);

// Concurrency-bound storm: ramp VUs (in-flight concurrency), NOT arrival rate, so requests
// queue on the Postgres pool while CPU idles on I/O wait (§6a#2).
export const options = {
  // Churn connections (no keep-alive reuse) so every request re-picks a pod via the Service —
  // otherwise, when KEDA scales up, existing pinned connections keep all load on the OLD pods and
  // the new pods sit idle (the keep-alive trap, worse on scale-up — plan §6b#2 / challenge #2).
  noConnectionReuse: true,
  scenarios: {
    storm: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '30s', target: 5 },     // baseline
        { duration: '15s', target: PEAK },  // alert-storm spike (~12x)
        { duration: '150s', target: PEAK }, // HOLD — long enough for scale-up lag (~1m) + scaled steady state (§6b#5)
        { duration: '20s', target: 5 },     // ramp down (then watch KEDA scale back to 2)
      ],
      gracefulRampDown: '10s',
    },
  },
  // The SLO gate. Under the CPU-HPA baseline (M5) this is EXPECTED to FAIL — that's the
  // proof CPU-HPA doesn't help. Under KEDA (M6) it should pass. abortOnFail stays off so
  // we observe the breach rather than kill the run.
  thresholds: {
    http_req_duration: [{ threshold: 'p(99)<200', abortOnFail: false }],
  },
};

function octet() {
  return Math.floor(Math.random() * 256);
}

export default function () {
  // Distinct 10.x.y.z across a ~16M space -> cache MISS -> PG pool contention.
  // Random space >> negative-cache TTL window so repeats are negligible (§6a#4/#5).
  const value = `10.${octet()}.${octet()}.${octet()}`;
  const res = http.post(
    `${BASE}/lookup`,
    JSON.stringify({ type: 'ip', value }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'status is 200': (r) => r.status === 200 });
}
