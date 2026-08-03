import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

// Cache-friendly SLO scenario (complements lookup-storm.js). OPEN model (arrival-rate),
// realistic hit/miss mix, to DEMONSTRATE p99 < 200ms on the stated cache-friendly workload —
// and, via a hit-ratio sweep, to show exactly where the miss-floor surfaces in the p99 tail.
// See docs/slo-scenario-spec.md.
const BASE = __ENV.TARGET || 'http://iocheck.iocheck.svc.cluster.local:3000';
const KEY = __ENV.IOC_ADMIN_API_KEY || '';
const HIT_RATIO = Number(__ENV.HIT_RATIO || 0.995);
const RATE = Number(__ENV.RATE || 60);          // requests/sec
const MODE = __ENV.MODE || 'steady';            // 'steady' | 'spike'
const H = Number(__ENV.HOT || 200);             // hot-set size

const JSONH = { 'Content-Type': 'application/json' };

// Threshold is on a CUSTOM trend recorded ONLY in the measured phase, so setup()'s warm-up
// misses (built-in http_req_duration) never pollute the SLO number.
const lookupDur = new Trend('lookup_duration', true);
const hitDur = new Trend('hit_duration', true);
const missDur = new Trend('miss_duration', true);
const hits = new Counter('hits');
const misses = new Counter('misses');

const steady = {
  slo: {
    executor: 'constant-arrival-rate',
    rate: RATE, timeUnit: '1s', duration: '3m',
    preAllocatedVUs: 50, maxVUs: 200,
  },
};
const spike = {
  slo: {
    executor: 'ramping-arrival-rate',
    startRate: RATE, timeUnit: '1s',
    preAllocatedVUs: 100, maxVUs: 400,
    stages: [
      { duration: '30s', target: RATE },        // baseline
      { duration: '15s', target: RATE * 10 },    // 10x cache-friendly burst
      { duration: '60s', target: RATE * 10 },    // hold
      { duration: '15s', target: RATE },         // back down
    ],
  },
};

export const options = {
  scenarios: MODE === 'spike' ? spike : steady,
  // The SLO gate — on the measured trend only. Expected PASS at high hit-ratio, FAIL as it drops.
  thresholds: { lookup_duration: [{ threshold: 'p(99)<200', abortOnFail: false }] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const hotValue = (i) => `192.0.2.${i}`;          // TEST-NET-1, seeded malicious
function freshValue() {
  // fresh unique -> genuine miss. 100.64.0.0/10 (CGNAT), huge space, distinct from hot + storm(10.x).
  const a = Math.floor(Math.random() * 64), b = Math.floor(Math.random() * 256), c = Math.floor(Math.random() * 256);
  return `100.${64 + a}.${b}.${c}`;
}

// setup(): seed the hot set as MALICIOUS (cached under CACHE_TTL 300s, NOT the 60s negative TTL),
// then warm the cache so measured hits are real hits. Batched to stay quick despite the 700ms miss floor.
export function setup() {
  const list = [];
  for (let i = 1; i <= H; i++) list.push(hotValue(i));
  const CHUNK = 25;
  // 1) upsert malicious (writes skip the modeled lookup latency, so this is fast)
  for (let s = 0; s < list.length; s += CHUNK) {
    http.batch(list.slice(s, s + CHUNK).map((v) => [
      'POST', `${BASE}/ioc`,
      JSON.stringify({ type: 'ip', value: v, source: 'slo-hot', score: 80 }),
      { headers: { ...JSONH, 'x-api-key': KEY } },
    ]));
  }
  // 2) warm the cache (first lookup is a 700ms miss -> caches the malicious verdict @300s TTL)
  for (let s = 0; s < list.length; s += CHUNK) {
    http.batch(list.slice(s, s + CHUNK).map((v) => [
      'POST', `${BASE}/lookup`, JSON.stringify({ type: 'ip', value: v }), { headers: JSONH },
    ]));
  }
  return { hot: list };
}

export default function (data) {
  let value, outcome;
  if (Math.random() < HIT_RATIO) {
    value = data.hot[Math.floor(Math.random() * data.hot.length)];   // cached malicious -> HIT (sub-ms)
    outcome = 'hit';
  } else {
    value = freshValue();                                            // never-seen -> genuine MISS (700ms)
    outcome = 'miss';
  }
  const res = http.post(`${BASE}/lookup`, JSON.stringify({ type: 'ip', value }),
    { headers: JSONH, tags: { outcome } });
  check(res, { 'status is 200': (r) => r.status === 200 });
  lookupDur.add(res.timings.duration);
  if (outcome === 'hit') { hitDur.add(res.timings.duration); hits.add(1); }
  else { missDur.add(res.timings.duration); misses.add(1); }
}
