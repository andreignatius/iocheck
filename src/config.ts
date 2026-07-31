import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once at startup and fails fast on misconfiguration.
 * Keeping config in one typed object means the rest of the app never reads process.env.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // /metrics is served on a SEPARATE port from the public API (§S8) so a NetworkPolicy
  // can expose it to the monitoring namespace ONLY — the public :PORT never serves the
  // operational metadata (verdict rates, request tempo) that reveals SOC activity.
  METRICS_PORT: z.coerce.number().int().positive().default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BODY_LIMIT: z.string().default('8kb'),

  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  // How long a request waits for a free pool connection before erroring. Under pool
  // saturation this bounds how high p99 climbs before requests 500 (§6a#3): a higher
  // value lets latency rise cleanly (queueing) instead of tipping into errors.
  PG_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Models a realistic backing-store round-trip latency (ms). 0 = off (default). When set,
  // the lookup holds a pool connection for this long via pg_sleep — so a cache-miss storm
  // saturates the pool and requests queue, reproducing the I/O-bound regime a real (larger/
  // remote) threat-intel store shows. A toy PK lookup on a 3-row table is unrealistically
  // sub-ms; this makes the CPU-vs-I/O demonstration faithful (§6a). Documented in REPORT.
  STORE_LOOKUP_LATENCY_MS: z.coerce.number().int().nonnegative().default(0),

  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  NEGATIVE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  IOC_ADMIN_API_KEY: z.string().min(1),

  SHUTDOWN_DRAIN_MS: z.coerce.number().int().nonnegative().default(10_000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Field names only — never print secret values.
  const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error(`Invalid/missing environment configuration: ${fields}`);
}

export const config = parsed.data;
export type Config = typeof config;
