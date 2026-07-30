import ipaddr from 'ipaddr.js';
import { z } from 'zod';

/**
 * Deep, per-type input validation + normalization (§S3).
 *
 * Normalization is a SECURITY control, not tidiness: without it, `EVIL.COM` and
 * `evil.com` become different rows and different cache keys, so an attacker could
 * evade a block by changing case, and the cache key space explodes.
 */
export const IOC_TYPES = ['ip', 'domain', 'sha256'] as const;
export type IocType = (typeof IOC_TYPES)[number];

const MAX_VALUE_LEN = 512;

// Lowercased, anchored hostname (RFC-1035-ish): labels 1-63 chars, total <= 253, a real TLD.
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Canonicalize an IP so semantically-identical addresses collapse to one form
 * (§S3): e.g. `0:0:0:0:0:0:0:1`, `::1`, `::0001` all -> `::1`. Text lowercasing
 * alone is NOT enough — IPv6 has many spellings of the same number, which would
 * otherwise create duplicate rows / cache keys and allow case/format evasion.
 * Returns null if the input is not a parseable IP (caller then rejects it).
 */
function canonicalizeIp(v: string): string | null {
  try {
    return ipaddr.parse(v).toString(); // RFC 5952 canonical: compressed + lowercased (v4 unchanged)
  } catch {
    return null;
  }
}

/** Canonicalize a value for its type before validation, storage, and cache-key building. */
export function normalizeValue(type: IocType, raw: string): string {
  const v = raw.trim();
  switch (type) {
    case 'ip':
      // Canonical form if parseable; otherwise a lowercased fallback that will fail validation.
      return canonicalizeIp(v) ?? v.toLowerCase();
    case 'domain':
      // Drop a single trailing dot (fully-qualified form), lowercase.
      return v.replace(/\.$/, '').toLowerCase();
    case 'sha256':
      return v.toLowerCase();
  }
}

/** True if `value` (already normalized) is structurally valid for `type`. */
export function isValidForType(type: IocType, value: string): boolean {
  switch (type) {
    case 'ip':
      return ipaddr.isValid(value);
    case 'domain':
      return DOMAIN_RE.test(value);
    case 'sha256':
      return SHA256_RE.test(value);
  }
}

const typeAndValue = {
  type: z.enum(IOC_TYPES),
  value: z.string().min(1).max(MAX_VALUE_LEN),
};

/**
 * Parse -> normalize -> per-type validate, in one pass. `.strict()` rejects unknown
 * fields. The transform emits the normalized value so callers store/lookup the
 * canonical form.
 */
export const LookupSchema = z
  .object(typeAndValue)
  .strict()
  .transform((data) => ({ type: data.type, value: normalizeValue(data.type, data.value) }))
  .refine((d) => isValidForType(d.type, d.value), {
    message: 'value is not a valid IOC for the given type',
    path: ['value'],
  });

export const UpsertSchema = z
  .object({
    ...typeAndValue,
    source: z.string().min(1).max(255),
    score: z.number().int().min(0).max(100),
  })
  .strict()
  .transform((data) => ({
    type: data.type,
    value: normalizeValue(data.type, data.value),
    source: data.source.trim(),
    score: data.score,
  }))
  .refine((d) => isValidForType(d.type, d.value), {
    message: 'value is not a valid IOC for the given type',
    path: ['value'],
  });

export type LookupInput = z.infer<typeof LookupSchema>;
export type UpsertInput = z.infer<typeof UpsertSchema>;
