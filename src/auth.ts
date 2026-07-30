import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';

/**
 * API-key auth for the privileged write path POST /ioc (§S1).
 *
 * The /ioc upsert is the crown jewels (§S6): whoever can write here can un-flag a
 * real threat (evasion) or flag a legit indicator as malicious (false-positive DoS
 * on the SOC). So this endpoint must be authenticated.
 *
 * Accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`. Constant-time compare
 * avoids leaking the key via timing. The key itself is never logged (redacted, §S7).
 */
function extractKey(req: Request): string | null {
  const headerKey = req.header('x-api-key');
  if (headerKey) return headerKey;
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual requires equal length; length check first is fine (length isn't secret).
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const provided = extractKey(req);
  if (!provided || !safeEqual(provided, config.IOC_ADMIN_API_KEY)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
