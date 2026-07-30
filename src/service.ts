import { cacheDel, cacheGet, cacheSet } from './cache';
import { config } from './config';
import { cacheEventsTotal, lookupResultsTotal } from './metrics';
import { findIoc, upsertIoc, type IocRecord } from './repository';
import type { IocType, LookupInput, UpsertInput } from './validation';

export type Verdict = 'malicious' | 'unknown';

export interface LookupResult {
  verdict: Verdict;
  ioc?: { type: IocType; value: string; source: string; score: number };
}

/** Sentinel stored in the cache to represent a known-negative (unknown) result (§3). */
const NEGATIVE = '__unknown__';

function keyFor(type: IocType, value: string): string {
  return `ioc:${type}:${value}`;
}

function toIoc(rec: IocRecord) {
  return { type: rec.type, value: rec.value, source: rec.source, score: rec.score };
}

/**
 * Read-through lookup with negative caching and fail-open behaviour.
 *
 * Path: cache -> (miss) Postgres -> populate cache. On a Redis outage cacheGet
 * returns null and cacheSet is a no-op, so this degrades to a direct DB read
 * (slower but correct) rather than failing (§O3).
 */
export async function lookup(input: LookupInput): Promise<LookupResult> {
  const key = keyFor(input.type, input.value);

  const cached = await cacheGet(key);
  if (cached !== null) {
    if (cached === NEGATIVE) {
      cacheEventsTotal.inc({ result: 'negative_hit' });
      lookupResultsTotal.inc({ type: input.type, verdict: 'unknown' });
      return { verdict: 'unknown' };
    }
    cacheEventsTotal.inc({ result: 'hit' });
    lookupResultsTotal.inc({ type: input.type, verdict: 'malicious' });
    return { verdict: 'malicious', ioc: JSON.parse(cached) };
  }

  cacheEventsTotal.inc({ result: 'miss' });
  const rec = await findIoc(input.type, input.value);

  if (rec) {
    await cacheSet(key, JSON.stringify(toIoc(rec)), config.CACHE_TTL_SECONDS);
    lookupResultsTotal.inc({ type: input.type, verdict: 'malicious' });
    return { verdict: 'malicious', ioc: toIoc(rec) };
  }

  // Negative cache: alert storms are read-heavy on misses too — keep them off the DB.
  await cacheSet(key, NEGATIVE, config.NEGATIVE_CACHE_TTL_SECONDS);
  lookupResultsTotal.inc({ type: input.type, verdict: 'unknown' });
  return { verdict: 'unknown' };
}

/** Admin upsert then invalidate the cache key so reads don't serve a stale verdict. */
export async function upsert(input: UpsertInput): Promise<IocRecord> {
  const rec = await upsertIoc(input);
  await cacheDel(keyFor(input.type, input.value));
  return rec;
}
