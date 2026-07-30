import { createClient, type RedisClientType } from 'redis';
import { config } from './config';
import { logger } from './logger';
import { cacheUp } from './metrics';

/**
 * Redis = cache and a SOFT dependency (§O3). If it is down we FAIL OPEN to Postgres:
 * every cache method swallows errors, flips the cache_up gauge to 0, and lets the
 * caller fall back to the DB. Redis being unreachable must never take the service down.
 *
 * Tight timeouts: a slow Redis should fail open FAST, not add latency to every request.
 */
const client: RedisClientType = createClient({
  // Fail commands IMMEDIATELY when not connected instead of queueing them — so a
  // Redis outage falls through to Postgres fast (fail-open) rather than hanging (§O3).
  disableOfflineQueue: true,
  socket: {
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    connectTimeout: 1_000,
    // Bounded reconnect backoff; never throw out of the reconnect strategy.
    reconnectStrategy: (retries) => Math.min(retries * 100, 2_000),
  },
  password: config.REDIS_PASSWORD,
});

client.on('error', (err) => {
  cacheUp.set(0);
  logger.warn({ err: (err as Error).message }, 'redis error (failing open to Postgres)');
});
client.on('ready', () => {
  cacheUp.set(1);
  logger.info('redis ready');
});

// node-redis auto-reconnects only AFTER a first successful connect. If Redis is
// down at startup, connect() rejects and would never retry — so we schedule our
// own bounded retry to recover from degraded -> healthy.
let connecting = false;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void attemptConnect();
  }, 2_000);
  reconnectTimer.unref();
}

async function attemptConnect(): Promise<void> {
  if (client.isOpen || connecting) return;
  connecting = true;
  try {
    await client.connect();
    cacheUp.set(1);
  } catch (err) {
    // Soft dep — come up degraded and keep retrying in the background.
    cacheUp.set(0);
    logger.warn({ err: (err as Error).message }, 'redis connect failed (degraded, will retry)');
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

export async function connectCache(): Promise<void> {
  await attemptConnect();
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const v = await client.get(key);
    cacheUp.set(1);
    return v;
  } catch {
    cacheUp.set(0);
    return null; // fail open
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await client.set(key, value, { EX: ttlSeconds });
  } catch {
    cacheUp.set(0); // fail open — a failed cache write is non-fatal
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await client.del(key);
  } catch {
    cacheUp.set(0);
  }
}

/** Reachability for observability only — NOT used to gate /readyz (soft dep, §O3). */
export async function pingCache(): Promise<boolean> {
  try {
    await client.ping();
    cacheUp.set(1);
    return true;
  } catch {
    cacheUp.set(0);
    return false;
  }
}

export async function closeCache(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (client.isOpen) await client.quit();
  } catch {
    /* already down — nothing to drain */
  }
}
