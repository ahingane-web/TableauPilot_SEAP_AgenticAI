/**
 * Vault cryptography.
 *
 * A user's secrets are encrypted at rest with AES-256-GCM. The key is derived from
 * the user's 6-digit PIN mixed with a per-user random salt AND a server-side pepper
 * (VAULT_PEPPER). Because a 6-digit PIN has low entropy, the pepper is what prevents
 * an attacker who steals only the on-disk vault from brute-forcing it offline.
 *
 * GCM's authentication tag doubles as PIN verification: decrypting with the wrong
 * derived key fails to authenticate, so we never store the PIN or a separate hash.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { getConfig } from '../config/env.js';

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard nonce
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface EncryptedBlob {
  /** base64 initialization vector */
  iv: string;
  /** base64 ciphertext */
  data: string;
  /** base64 GCM auth tag */
  tag: string;
}

/** Derive a 32-byte key from PIN + salt + server pepper. */
export function deriveKey(pin: string, saltHex: string): Buffer {
  const pepper = getConfig().vault.pepper;
  if (!pepper) {
    // Fail closed — refuse to derive a weak key without the pepper.
    throw new Error('VAULT_PEPPER is not configured; refusing to derive a vault key.');
  }
  const salt = Buffer.from(saltHex, 'hex');
  const material = `${pin}\u0000${pepper}`;
  return scryptSync(material, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

export function newSaltHex(): string {
  return randomBytes(16).toString('hex');
}

export function encrypt(key: Buffer, plaintext: string): EncryptedBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), data: enc.toString('base64'), tag: tag.toString('base64') };
}

/** Decrypt a blob. Throws if the key is wrong (auth tag mismatch) or data is corrupt. */
export function decrypt(key: Buffer, blob: EncryptedBlob): string {
  const iv = Buffer.from(blob.iv, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

/** Known constant used as a PIN verifier so we can validate a PIN before any creds exist. */
const VERIFIER_PLAINTEXT = 'tableaupilot-vault-verifier-v1';

export function makeVerifier(key: Buffer): EncryptedBlob {
  return encrypt(key, VERIFIER_PLAINTEXT);
}

/** True iff the derived key correctly decrypts the verifier (i.e. the PIN is correct). */
export function checkVerifier(key: Buffer, verifier: EncryptedBlob): boolean {
  try {
    const out = decrypt(key, verifier);
    const a = Buffer.from(out);
    const b = Buffer.from(VERIFIER_PLAINTEXT);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** A 6-digit PIN: exactly six numeric characters. */
export function isValidPin(pin: string): boolean {
  return /^[0-9]{6}$/.test(pin);
}
