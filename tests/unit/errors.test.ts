import { describe, it, expect } from 'vitest';
import { AppError, sanitizeError } from '../../src/utils/errors.js';
import { REDACTED } from '../../src/utils/redaction.js';

describe('errors + sanitization', () => {
  it('maps error codes to HTTP statuses', () => {
    expect(new AppError('VALIDATION', 'x').status).toBe(400);
    expect(new AppError('AUTH_REQUIRED', 'x').status).toBe(401);
    expect(new AppError('PIN_LOCKED', 'x').status).toBe(423);
    expect(new AppError('PERMISSION_DENIED', 'x').status).toBe(403);
    expect(new AppError('INTERNAL', 'x').status).toBe(500);
  });

  it('redacts secrets embedded in an error message', () => {
    const err = new AppError('TABLEAU_API', 'failed with token sk-ant-abcd1234efgh');
    expect(err.message).toContain(REDACTED);
    expect(err.message).not.toContain('sk-ant-abcd1234efgh');
  });

  it('sanitizes an AppError and redacts its details', () => {
    const err = new AppError('VALIDATION', 'bad', { hint: 'do better', details: { patSecret: 'leak-me' } });
    const safe = sanitizeError(err);
    expect(safe.code).toBe('VALIDATION');
    expect(safe.status).toBe(400);
    expect(safe.hint).toBe('do better');
    expect((safe.details as Record<string, unknown>).patSecret).toBe(REDACTED);
  });

  it('converts an unknown thrown value into a safe internal error', () => {
    const safe = sanitizeError('a raw string with sk-ant-abcd1234efgh');
    expect(safe.code).toBe('INTERNAL');
    expect(safe.status).toBe(500);
  });

  it('redacts secrets when sanitizing a plain Error', () => {
    const safe = sanitizeError(new Error('boom sk-or-v1-abcdefgh12345678'));
    expect(safe.message).not.toContain('sk-or-v1-abcdefgh12345678');
    expect(safe.message).toContain(REDACTED);
  });
});
