import { Pool } from 'pg';
import { config } from './config';
import { logger } from './logger';

/**
 * Postgres = source of truth and the HARD dependency (§O3): if it is unreachable
 * we cannot serve correct verdicts, so /readyz fails when this ping fails.
 *
 * The pool size (PG_POOL_MAX) x replica count must stay under Postgres
 * max_connections — this is what bounds max replicas (§O8).
 */
export const pool = new Pool({
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  max: config.PG_POOL_MAX,
  // Fail fast rather than let a request hang on a saturated pool during a storm.
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // Background idle-client errors — log, don't crash the process.
  logger.error({ err }, 'postgres pool error');
});

/** Liveness of the DB dependency (hard dep for /readyz). */
export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.error({ err }, 'postgres ping failed');
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
