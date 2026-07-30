import type { Server } from 'node:http';
import { createApp } from './app';
import { closeCache, connectCache } from './cache';
import { closeDb } from './db';
import { config } from './config';
import { logger } from './logger';
import { beginDraining } from './state';

async function main(): Promise<void> {
  // Redis is a soft dep — connect (degrades gracefully if it fails), then listen.
  await connectCache();

  const app = createApp();
  const server: Server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'iocheck listening');
  });

  installGracefulShutdown(server);
}

/**
 * Graceful shutdown (§O2). In k8s the preStop hook has ALREADY slept (so endpoint
 * removal has propagated) by the time SIGTERM reaches us. Here we: stop accepting
 * (flip readiness -> 503), stop new connections + drain in-flight, then close the
 * DB pool and Redis, all inside terminationGracePeriodSeconds.
 */
function installGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated — draining');

    beginDraining(); // /readyz now returns 503

    // Hard cap: if drain hangs, force-close any stragglers and exit before k8s
    // SIGKILLs us at the grace deadline.
    const forceTimer = setTimeout(() => {
      logger.error('drain timed out — forcing connections closed and exiting');
      server.closeAllConnections();
      process.exit(1);
    }, config.SHUTDOWN_DRAIN_MS);
    forceTimer.unref();

    server.close(async () => {
      try {
        await closeCache();
        await closeDb();
        logger.info('drain complete — exiting cleanly');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'error during resource close');
        process.exit(1);
      }
    });

    // Release idle keep-alive sockets immediately so server.close() can complete
    // promptly; in-flight requests are still allowed to finish (§O2).
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
