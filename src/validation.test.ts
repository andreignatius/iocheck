import { describe, expect, it } from 'vitest';
import { LookupSchema, UpsertSchema, isValidForType, normalizeValue } from './validation';

describe('normalizeValue (canonicalization — §S3)', () => {
  it('lowercases domains so EVIL.COM cannot evade a block on evil.com', () => {
    expect(normalizeValue('domain', 'EVIL.COM')).toBe('evil.com');
  });
  it('strips a trailing dot on a fully-qualified domain', () => {
    expect(normalizeValue('domain', 'Example.COM.')).toBe('example.com');
  });
  it('lowercases sha256 hashes', () => {
    expect(normalizeValue('sha256', 'ABCDEF'.repeat(0) + 'A'.repeat(64))).toBe('a'.repeat(64));
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeValue('ip', '  10.0.0.1  ')).toBe('10.0.0.1');
  });
  it('canonicalizes equivalent IPv6 spellings to one form (anti-dedup/evasion)', () => {
    const a = normalizeValue('ip', '::1');
    const b = normalizeValue('ip', '0:0:0:0:0:0:0:1');
    const c = normalizeValue('ip', '::0001');
    expect(a).toBe('::1');
    expect(b).toBe('::1');
    expect(c).toBe('::1');
    expect(new Set([a, b, c]).size).toBe(1); // same row, same cache key
  });
  it('compresses and lowercases a full IPv6 address', () => {
    expect(normalizeValue('ip', '2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
  });
});

describe('isValidForType (per-type validation — §S3)', () => {
  it('accepts valid IPv4 and IPv6, rejects junk', () => {
    expect(isValidForType('ip', '203.0.113.7')).toBe(true);
    expect(isValidForType('ip', '2001:db8::1')).toBe(true);
    expect(isValidForType('ip', '999.999.999.999')).toBe(false);
    expect(isValidForType('ip', 'not-an-ip')).toBe(false);
  });
  it('accepts real hostnames, rejects schemes/spaces', () => {
    expect(isValidForType('domain', 'sub.example.com')).toBe(true);
    expect(isValidForType('domain', 'http://example.com')).toBe(false);
    expect(isValidForType('domain', 'no_tld')).toBe(false);
  });
  it('requires exactly 64 hex chars for sha256', () => {
    expect(isValidForType('sha256', 'a'.repeat(64))).toBe(true);
    expect(isValidForType('sha256', 'a'.repeat(63))).toBe(false);
    expect(isValidForType('sha256', 'g'.repeat(64))).toBe(false);
  });
});

describe('LookupSchema', () => {
  it('normalizes then validates, emitting the canonical value', () => {
    const out = LookupSchema.parse({ type: 'domain', value: 'EVIL.COM' });
    expect(out).toEqual({ type: 'domain', value: 'evil.com' });
  });
  it('rejects unknown fields (strict)', () => {
    expect(() => LookupSchema.parse({ type: 'ip', value: '10.0.0.1', extra: 1 })).toThrow();
  });
  it('rejects a value that is invalid for its type', () => {
    expect(() => LookupSchema.parse({ type: 'sha256', value: 'deadbeef' })).toThrow();
  });
  it('rejects an over-long value (>512)', () => {
    expect(() => LookupSchema.parse({ type: 'domain', value: 'a'.repeat(600) })).toThrow();
  });
});

describe('UpsertSchema', () => {
  it('accepts a well-formed record and clamps nothing valid', () => {
    const out = UpsertSchema.parse({
      type: 'ip',
      value: '203.0.113.7',
      source: 'abuseipdb',
      score: 90,
    });
    expect(out).toEqual({ type: 'ip', value: '203.0.113.7', source: 'abuseipdb', score: 90 });
  });
  it('rejects score out of range', () => {
    expect(() =>
      UpsertSchema.parse({ type: 'ip', value: '203.0.113.7', source: 's', score: 101 }),
    ).toThrow();
  });
});
