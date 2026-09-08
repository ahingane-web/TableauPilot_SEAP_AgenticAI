/**
 * VaultService — the per-user, PIN-protected credential store.
 *
 * Flow implemented (per product requirement):
 *   1. First time: a user registers a username + 6-digit PIN (sets up the vault).
 *   2. They save their Tableau credentials; these are encrypted with a key derived
 *      from their PIN and can only be read back after the PIN is re-entered.
 *   3. On every later login the user enters their PIN; correct PIN unlocks and
 *      decrypts the saved secret into a memory-only session.
 *   4. Any user can register and keep their own secrets, isolated by username.
 *
 * Brute-force resistance: wrong PINs increment a counter; after VAULT_MAX_ATTEMPTS
 * the account is locked for VAULT_LOCKOUT_SECONDS. Combined with the server pepper,
 * this makes a 6-digit PIN safe enough for this workflow.
 */
import { getConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  checkVerifier,
  decrypt,
  deriveKey,
  encrypt,
  isValidPin,
  makeVerifier,
  newSaltHex,
} from './crypto.js';
import { createSession, destroySession, getSession, type Session } from './session.js';
import { getRecord, hasUser, putRecord } from './store.js';
import { summarizeCredentials, type CredentialSummary, type TableauCredentials, type VaultRecord } from './types.js';

const log = logger.child('vault');

export interface UnlockResult {
  sessionId: string;
  username: string;
  hasCredentials: boolean;
  credentialSummary?: CredentialSummary;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const VaultService = {
  isRegistered(username: string): boolean {
    return hasUser(username);
  },

  /** Register a new user with a 6-digit PIN. Fails if the username already exists. */
  register(username: string, pin: string): UnlockResult {
    const uname = username.trim();
    if (!uname) throw new AppError('VALIDATION', 'Username is required.');
    if (!isValidPin(pin)) throw new AppError('VALIDATION', 'PIN must be exactly 6 digits.');
    if (hasUser(uname)) {
      throw new AppError('VALIDATION', 'That username is already registered.', {
        hint: 'Choose a different username or unlock the existing one with your PIN.',
      });
    }
    const saltHex = newSaltHex();
    const key = deriveKey(pin, saltHex);
    const record: VaultRecord = {
      username: uname,
      saltHex,
      verifier: makeVerifier(key),
      creds: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      failedAttempts: 0,
      lockedUntil: null,
    };
    putRecord(record);
    log.info('Registered vault user', { username: uname });
    const session = createSession(uname, key);
    return { sessionId: session.id, username: uname, hasCredentials: false };
  },

  /** Unlock an existing vault with the PIN; returns a session id on success. */
  unlock(username: string, pin: string): UnlockResult {
    const uname = username.trim();
    const record = getRecord(uname);
    if (!record) {
      throw new AppError('AUTH_FAILED', 'No vault found for that username.', {
        hint: 'Register first, or check the username.',
      });
    }
    const cfg = getConfig().vault;
    if (record.lockedUntil && record.lockedUntil > Date.now()) {
      const seconds = Math.ceil((record.lockedUntil - Date.now()) / 1000);
      throw new AppError('PIN_LOCKED', `Too many attempts. Try again in ${seconds}s.`);
    }
    if (!isValidPin(pin)) throw new AppError('VALIDATION', 'PIN must be exactly 6 digits.');

    const key = deriveKey(pin, record.saltHex);
    if (!checkVerifier(key, record.verifier)) {
      record.failedAttempts += 1;
      if (record.failedAttempts >= cfg.maxAttempts) {
        record.lockedUntil = Date.now() + cfg.lockoutSeconds * 1000;
        record.failedAttempts = 0;
        putRecord(record);
        log.warn('Vault locked after failed attempts', { username: uname });
        throw new AppError('PIN_LOCKED', `Too many attempts. Locked for ${cfg.lockoutSeconds}s.`);
      }
      putRecord(record);
      const remaining = cfg.maxAttempts - record.failedAttempts;
      throw new AppError('AUTH_FAILED', `Incorrect PIN. ${remaining} attempt(s) remaining.`);
    }

    // Success — reset counters.
    record.failedAttempts = 0;
    record.lockedUntil = null;
    record.updatedAt = nowIso();
    putRecord(record);

    let credentials: TableauCredentials | undefined;
    if (record.creds) {
      try {
        credentials = JSON.parse(decrypt(key, record.creds)) as TableauCredentials;
      } catch {
        throw new AppError('INTERNAL', 'Stored credentials could not be decrypted.');
      }
    }
    const session = createSession(uname, key, credentials);
    log.info('Vault unlocked', { username: uname, hasCredentials: Boolean(credentials) });
    return {
      sessionId: session.id,
      username: uname,
      hasCredentials: Boolean(credentials),
      credentialSummary: credentials ? summarizeCredentials(credentials) : undefined,
    };
  },

  /** Persist (encrypt) Tableau credentials for the session's user. */
  saveCredentials(session: Session, creds: TableauCredentials): CredentialSummary {
    const record = getRecord(session.username);
    if (!record) throw new AppError('AUTH_REQUIRED', 'Session user no longer exists.');
    validateCredentials(creds);
    record.creds = encrypt(session.vaultKey, JSON.stringify(creds));
    record.updatedAt = nowIso();
    putRecord(record);
    session.credentials = creds;
    log.info('Saved Tableau credentials to vault', {
      username: session.username,
      hasConnectedApp: Boolean(creds.connectedApp),
    });
    return summarizeCredentials(creds);
  },

  /** Read decrypted credentials from the live session (never from disk on demand). */
  getCredentials(session: Session): TableauCredentials {
    if (!session.credentials) {
      throw new AppError('AUTH_REQUIRED', 'No Tableau credentials saved for this session.', {
        hint: 'Enter and save your Tableau connection details first.',
      });
    }
    return session.credentials;
  },

  logout(sessionId: string): void {
    destroySession(sessionId);
  },

  requireSession(sessionId: string | undefined | null): Session {
    const s = getSession(sessionId);
    if (!s) throw new AppError('AUTH_REQUIRED', 'Session expired or not found. Please unlock your vault again.');
    return s;
  },
};

function validateCredentials(creds: TableauCredentials): void {
  const problems: string[] = [];
  if (!creds.cloudUrl?.startsWith('http')) problems.push('cloudUrl must be a full https URL.');
  if (!creds.siteContentUrl) problems.push('siteContentUrl is required.');
  if (!creds.patName) problems.push('patName is required.');
  if (!creds.patSecret) problems.push('patSecret is required.');
  if (creds.connectedApp) {
    const ca = creds.connectedApp;
    if (!ca.clientId || !ca.secretId || !ca.secretValue) {
      problems.push('Connected App requires clientId, secretId and secretValue together.');
    }
  }
  if (problems.length) {
    throw new AppError('VALIDATION', `Invalid Tableau credentials:\n - ${problems.join('\n - ')}`);
  }
}
