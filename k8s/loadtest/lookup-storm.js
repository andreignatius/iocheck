import http from 'k6/http';
import { check } from 'k6';

// Target the Service (not a pod) so kube-proxy load-balances across replicas (§6a#9).
const BASE = __ENV.TARGET || 'http://iocheck.iocheck.svc.cluster.local:3000';
const PEAK = Number(__ENV.PEAK_VUS || 60);

// Concurrency-bound storm: ramp VUs (in-flight concurrency), NOT arrival rate, so requests
// queue on the Postgres pool while CPU idles on I/O wait (§6a#2).
export const options = {
  scenarios: {
    storm: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '30s', target: 5 },     // baseline
        { duration: '15s', target: PEAK },  // alert-storm spike (~12x)
        { duration: '90s', target: PEAK },  // HOLD the spike (outlast metrics-server 15s + HPA sync, §6a#8)
        { duration: '20s', target: 5 },     // ramp down
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
