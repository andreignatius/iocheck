import type { NextFunction, Request, Response } from 'express';
import { pingCache } from './cache';
import { pingDb } from './db';
import { logger } from './logger';
import { lookup, upsert } from './service';
import { isAcceptingTraffic } from './state';
import { LookupSchema, UpsertSchema } from './validation';

/**
 * HTTP controllers — thin request/response glue only. All business logic lives in
 * `service.ts` (which owns the cache/store) and `repository.ts` (data access); these
 * handlers just validate input, call the service, and shape the response. Keeping them
 * here (rather than inline in app.ts) keeps the app wiring readable as the surface grows.
 */

// --- POST /lookup (read tier) ---
export async function postLookup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = LookupSchema.parse(req.body);
    res.status(200).json(await lookup(input));
  } catch (err) {
    next(err);
  }
}

// --- POST /ioc (privileged write — auth is enforced by requireAdminKey middleware, §S1) ---
export async function postIoc(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = UpsertSchema.parse(req.body);
    const rec = await upsert(input);
    // AUDIT (§S7): the /ioc write is the crown jewels — un-flagging a real threat is an
    // evasion, flagging a legit indicator is a SOC DoS. Record who (key fingerprint, never
    // the key), from where, and exactly what changed. NB: this DELIBERATELY logs the IOC
    // value — the "no IOC values in logs" rule targets the high-volume *lookup* path
    // (analyst investigation patterns); a privileged *mutation* audit trail is useless
    // without the object it mutated, and accountability for tampering outweighs the
    // confidentiality of the block-set here. Low volume (admin writes), never the read path.
    logger.info(
      {
        event: 'ioc_upsert',
        actor: res.locals.actor,
        src_ip: req.ip,
        type: rec.type,
        value: rec.value,
        source: rec.source,
        score: rec.score,
      },
      'audit: ioc upsert',
    );
    res.status(201).json({
      type: rec.type,
      value: rec.value,
      source: rec.source,
      score: rec.score,
    });
  } catch (err) {
    next(err);
  }
}

// --- liveness: process-only, NEVER checks deps (§O3) ---
export function getHealthz(_req: Request, res: Response): void {
  res.status(200).json({ status: 'ok' });
}

// --- readiness: Postgres is a HARD dep; Redis is soft (reported, not gating) (§O3) ---
export async function getReadyz(_req: Request, res: Response): Promise<void> {
  if (!isAcceptingTraffic()) {
    res.status(503).json({ status: 'draining' });
    return;
  }
  const dbOk = await pingDb();
  const cacheOk = await pingCache(); // reported only — does NOT gate readiness
  if (!dbOk) {
    res.status(503).json({ status: 'not-ready', db: false, cache: cacheOk });
    return;
  }
  res.status(200).json({ status: 'ready', db: true, cache: cacheOk });
}
