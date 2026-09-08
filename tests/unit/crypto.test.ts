import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encrypt,
  decrypt,
  newSaltHex,
  makeVerifier,
  checkVerifier,
  isValidPin,
} from '../../src/vault/crypto.js';

describe('vault crypto', () => {
  it('validates 6-digit PINs strictly', () => {
    expect(isValidPin('123456')).toBe(true);
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('1234567')).toBe(false);
    expect(isValidPin('12a456')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });

  it('round-trips ciphertext with the correct key', () => {
    const salt = newSaltHex();
    const key = deriveKey('123456', salt);
    const blob = encrypt(key, 'super secret PAT');
    expect(blob.data).not.toContain('super secret');
    expect(decrypt(key, blob)).toBe('super secret PAT');
  });

  it('fails to decrypt with a wrong PIN (GCM auth tag)', () => {
    const salt = newSaltHex();
    const good = deriveKey('123456', salt);
    const bad = deriveKey('654321', salt);
    const blob = encrypt(good, 'payload');
    expect(() => decrypt(bad, blob)).toThrow();
  });

  it('derives different keys for the same PIN under different salts', () => {
    const k1 = deriveKey('111111', newSaltHex());
    const k2 = deriveKey('111111', newSaltHex());
    expect(k1.equals(k2)).toBe(false);
  });

  it('verifier passes for the right key and fails for the wrong one', () => {
    const salt = newSaltHex();
    const key = deriveKey('000000', salt);
    const verifier = makeVerifier(key);
    expect(checkVerifier(key, verifier)).toBe(true);
    expect(checkVerifier(deriveKey('999999', salt), verifier)).toBe(false);
  });
});
