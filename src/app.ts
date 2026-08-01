import express, { type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { requireAdminKey } from './auth';
import { config } from './config';
import { getHealthz, getReadyz, postIoc, postLookup } from './controllers';
import { logger } from './logger';
import {
  httpInFlight,
  httpRequestDuration,
  httpRequestsTotal,
  registry,
} from './metrics';

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

  // --- routes: thin handlers live in controllers.ts (logic in service/repository) ---
  app.post('/lookup', postLookup);                    // read tier
  app.post('/ioc', requireAdminKey, postIoc);         // privileged write — auth first (§S1)
  app.get('/healthz', getHealthz);                    // liveness (process-only, §O3)
  app.get('/readyz', getReadyz);                      // readiness (PG hard / Redis soft, §O3)

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
