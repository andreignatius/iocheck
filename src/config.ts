import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once at startup and fails fast on misconfiguration.
 * Keeping config in one typed object means the rest of the app never reads process.env.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BODY_LIMIT: z.string().default('8kb'),

  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

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
