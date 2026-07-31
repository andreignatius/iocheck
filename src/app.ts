import express, { type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { requireAdminKey } from './auth';
import { pingDb } from './db';
import { pingCache } from './cache';
import { config } from './config';
import { logger } from './logger';
import {
  httpInFlight,
  httpRequestDuration,
  httpRequestsTotal,
  registry,
} from './metrics';
import { lookup, upsert } from './service';
import { isAcceptingTraffic } from './state';
import { LookupSchema, UpsertSchema } from './validation';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Oversized-body DoS guard (§S3).
  app.use(express.json({ limit: config.BODY_LIMIT }));
  // autoLogging off: at storm RPS a per-request access log is a real CPU cost, and NOT
  // logging every lookup avoids recording sensitive query patterns (§S7). Prometheus
  // metrics remain the request-level observability; errors still log via the handler.
  app.use(pinoHttp({ logger, autoLogging: false }));

  // --- metrics middleware: RPS, latency, in-flight (§O6) ---
  // route label is the fixed pattern (never the raw URL) to keep cardinality bounded.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const end = httpRequestDuration.startTimer();
    httpInFlight.inc();
    // Finalize exactly once — on 'finish' (normal) OR 'close' (client aborted),
    // otherwise an aborted request leaks the in-flight gauge and never ends the timer.
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      // Only record a concrete route when one actually matched; collapse all
      // unmatched paths (404 scanners etc.) into one series to bound cardinality.
      const route = req.route?.path ?? 'unmatched';
      const labels = { route, method: req.method, status: String(res.statusCode) };
      httpRequestsTotal.inc(labels);
      end(labels);
      httpInFlight.dec();
    };
    res.on('finish', finalize);
    res.on('close', finalize);
    next();
  });

  // --- POST /lookup (read tier) ---
  app.post('/lookup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = LookupSchema.parse(req.body);
      res.status(200).json(await lookup(input));
    } catch (err) {
      next(err);
    }
  });

  // --- POST /ioc (privileged write — authenticated, §S1) ---
  app.post('/ioc', requireAdminKey, async (req: Request, res: Response, next: NextFunction) => {
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
  });

  // --- liveness: process-only, NEVER checks deps (§O3) ---
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // --- readiness: Postgres is a HARD dep; Redis is soft (reported, not gating) (§O3) ---
  app.get('/readyz', async (_req: Request, res: Response) => {
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
  });

  // NOTE: /metrics is deliberately NOT served on this (public) app. It lives on a
  // separate internal listener (createMetricsApp, bound to METRICS_PORT) so a
  // NetworkPolicy can restrict it to the monitoring namespace only — the public API
  // port never exposes operational metadata (verdict rates / request tempo reveal SOC
  // activity even without IOC values, §S8).

  // --- generic error handler: no stack traces / DB errors leak to clients (§S10) ---
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'invalid request', details: err.issues });
      return;
    }
    // body-parser errors: oversized body -> 413 (DoS guard §S3), bad JSON -> 400.
    if (err && typeof err === 'object' && 'type' in err) {
      const type = (err as { type?: string }).type;
      if (type === 'entity.too.large') {
        res.status(413).json({ error: 'payload too large' });
        return;
      }
      if (type === 'entity.parse.failed') {
        res.status(400).json({ error: 'malformed JSON' });
        return;
      }
    }
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

/**
 * The metrics-only app, served on a SEPARATE internal port (METRICS_PORT) from the
 * public API (§S8). Keeping /metrics off the public port lets a NetworkPolicy expose it
 * to the monitoring namespace ONLY — NetworkPolicy is L3/L4 and can't gate a single HTTP
 * path, so port separation is the mechanism. The instrumentation MIDDLEWARE stays on the
 * public app (it records real traffic); this app only *exposes* the shared registry.
 */
export function createMetricsApp() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
  return app;
}
