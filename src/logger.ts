import pino from 'pino';
import { config } from './config';

/**
 * Structured JSON logging (pino). In prod, JSON logs ship to a collector.
 * Never log secrets or full IOC values at info level (§S7, §S10).
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    // Defensive: if any of these ever appear in a log object, mask them.
    paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'password', '*.password'],
    censor: '[redacted]',
  },
});
