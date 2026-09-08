import { describe, it, expect } from 'vitest';
import { redact, redactString, looksLikeSecret, REDACTED } from '../../src/utils/redaction.js';

describe('redaction', () => {
  it('redacts values under sensitive keys', () => {
    const out = redact({ patSecret: 'abc', password: 'p', token: 't', name: 'ok' }) as Record<string, unknown>;
    expect(out.patSecret).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.name).toBe('ok');
  });

  it('scrubs secret-looking substrings inside free strings', () => {
    expect(redactString('key sk-ant-abcd1234efgh end')).toContain(REDACTED);
    expect(redactString('Authorization: Bearer abcdef1234567890')).toContain(REDACTED);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4In0.c2lnbmF0dXJlZGF0YQ';
    expect(redactString(`tok ${jwt}`)).toContain(REDACTED);
  });

  it('recurses into nested objects and arrays', () => {
    const out = redact({ a: { b: [{ apiKey: 'x' }] }, list: ['plain'] }) as any;
    expect(out.a.b[0].apiKey).toBe(REDACTED);
    expect(out.list[0]).toBe('plain');
  });

  it('handles circular references without throwing', () => {
    const obj: any = { name: 'root' };
    obj.self = obj;
    const out = redact(obj) as any;
    expect(out.name).toBe('root');
    expect(out.self).toBe('[Circular]');
  });

  it('looksLikeSecret detects tokens but not plain text', () => {
    expect(looksLikeSecret('sk-or-v1-abcdefgh12345678')).toBe(true);
    expect(looksLikeSecret('just a normal sentence')).toBe(false);
  });
});
