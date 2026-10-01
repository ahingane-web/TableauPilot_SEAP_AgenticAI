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
import {
  summarizeCredentials,
  type CredentialSummary,
  type TableauCredentials,
  type VaultDataCloudLogin,
  type VaultRecord,
  type VaultSalesforceLogin,
  type VaultSnowflakeLogin,
} from './types.js';

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

/**
 * Verify a PIN against a vault record, applying lockout/rate-limiting. Returns the
 * derived vault key on success. Shared by unlock and by credential update/delete so
 * those paths enforce the same brute-force protection and behave identically.
 */
function verifyPinOrThrow(record: VaultRecord, pin: string): Buffer {
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
      log.warn('Vault locked after failed attempts', { username: record.username });
      throw new AppError('PIN_LOCKED', `Too many attempts. Locked for ${cfg.lockoutSeconds}s.`);
    }
    putRecord(record);
    const remaining = cfg.maxAttempts - record.failedAttempts;
    throw new AppError('AUTH_FAILED', `Incorrect PIN. ${remaining} attempt(s) remaining.`);
  }

  record.failedAttempts = 0;
  record.lockedUntil = null;
  putRecord(record);
  return key;
}

/**
 * Changing credentials invalidates any live Tableau connection and the in-flight
 * workflow context (project/datasource/plan), since they may no longer apply to the
 * new credentials. Clears them so the user reconnects cleanly.
 */
function resetTableauState(session: Session): void {
  session.tableauAuth = undefined;
  session.flow = {};
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

    const key = verifyPinOrThrow(record, pin);
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
    const next = keepConnectorLogins(session.credentials, creds);
    record.creds = encrypt(session.vaultKey, JSON.stringify(next));
    record.updatedAt = nowIso();
    putRecord(record);
    session.credentials = next;
    log.info('Saved Tableau credentials to vault', {
      username: session.username,
      hasConnectedApp: Boolean(next.connectedApp),
    });
    return summarizeCredentials(next);
  },

  /**
   * Modify saved credentials AFTER re-confirming the user's PIN. Even within an
   * unlocked session, changing stored secrets requires the PIN again (per product
   * requirement). Succeeds only for the correct PIN, subject to lockout.
   */
  updateCredentials(session: Session, pin: string, creds: TableauCredentials): CredentialSummary {
    const record = getRecord(session.username);
    if (!record) throw new AppError('AUTH_REQUIRED', 'Session user no longer exists.');

    const key = verifyPinOrThrow(record, pin);
    validateCredentials(creds);
    const next = keepConnectorLogins(session.credentials, creds);

    record.creds = encrypt(key, JSON.stringify(next));
    record.updatedAt = nowIso();
    putRecord(record);

    session.vaultKey = key;
    session.credentials = next;
    resetTableauState(session);

    log.info('Updated Tableau credentials in vault', {
      username: session.username,
      hasConnectedApp: Boolean(next.connectedApp),
    });
    return summarizeCredentials(next);
  },

  /**
   * Remove saved Tableau credentials AFTER re-confirming the PIN. The vault user
   * (username + PIN) remains; only the encrypted credential blob is cleared. Live
   * Tableau auth, workflow context, and transient connector state are reset.
   */
  deleteCredentials(session: Session, pin: string): void {
    const record = getRecord(session.username);
    if (!record) throw new AppError('AUTH_REQUIRED', 'Session user no longer exists.');
    verifyPinOrThrow(record, pin);
    record.creds = null;
    record.updatedAt = nowIso();
    putRecord(record);
    session.credentials = undefined;
    session.connectors = undefined;
    resetTableauState(session);
    log.info('Deleted Tableau credentials from vault', { username: session.username });
  },

  /** Non-secret summary of the session's saved credentials (for prefilling edits). */
  getCredentialSummary(session: Session): CredentialSummary | null {
    return session.credentials ? summarizeCredentials(session.credentials) : null;
  },

  /**
   * Persist (or clear) the BigQuery connector's Google OAuth *client* id/secret, merged into
   * the user's saved credentials and re-encrypted with the session vault key (no PIN re-entry,
   * mirroring `saveCredentials`). This is the app-registration credential, NOT the per-user
   * access token. Passing an empty `clientId` removes it. Requires Tableau credentials to have
   * been saved first (the vault blob is keyed to the user's saved connection).
   */
  saveBigQueryOAuthClient(
    session: Session,
    input: { clientId: string; clientSecret?: string },
  ): CredentialSummary {
    const record = getRecord(session.username);
    if (!record) throw new AppError('AUTH_REQUIRED', 'Session user no longer exists.');
    if (!session.credentials) {
      throw new AppError('AUTH_REQUIRED', 'Save your Tableau connection details first, then save the BigQuery client.', {
        hint: 'Connect to Tableau Cloud (save credentials) before storing the BigQuery OAuth client.',
      });
    }
    const clientId = input.clientId.trim();
    let clientSecret = input.clientSecret?.trim();
    // Preserve a previously-saved secret when the caller omits one for the SAME client id
    // (the UI never prefills the secret field, so a blank submit must not wipe it).
    const existing = session.credentials.bigQueryOAuth;
    if (!clientSecret && existing?.clientId === clientId && existing?.clientSecret) {
      clientSecret = existing.clientSecret;
    }
    const next: TableauCredentials = {
      ...session.credentials,
      bigQueryOAuth: clientId ? { clientId, ...(clientSecret ? { clientSecret } : {}) } : undefined,
    };
    record.creds = encrypt(session.vaultKey, JSON.stringify(next));
    record.updatedAt = nowIso();
    putRecord(record);
    session.credentials = next;
    log.info('Saved BigQuery OAuth client to vault', {
      username: session.username,
      hasClient: Boolean(clientId),
      hasSecret: Boolean(clientSecret),
    });
    return summarizeCredentials(next);
  },

  /** Read the saved BigQuery OAuth client from the live session (secret included; server-only). */
  getBigQueryOAuthClient(session: Session): { clientId?: string; clientSecret?: string } {
    const bq = session.credentials?.bigQueryOAuth;
    return { clientId: bq?.clientId, clientSecret: bq?.clientSecret };
  },

  /** PIN-gated replace of the BigQuery OAuth client (empty clientId clears it). */
  updateBigQueryOAuthClient(
    session: Session,
    pin: string,
    input: { clientId: string; clientSecret?: string },
  ): CredentialSummary {
    requirePin(session, pin);
    return VaultService.saveBigQueryOAuthClient(session, input);
  },

  /** PIN-gated delete of the BigQuery OAuth client only. */
  deleteBigQueryOAuthClient(session: Session, pin: string): CredentialSummary {
    requirePin(session, pin);
    return VaultService.saveBigQueryOAuthClient(session, { clientId: '' });
  },

  saveSalesforceAccount(session: Session, input: VaultSalesforceLogin): CredentialSummary {
    const login = normalizeSalesforceLogin(input, session.credentials?.salesforce);
    return persistConnectorSlice(session, (creds) => ({ ...creds, salesforce: login }), 'Saved Salesforce login to vault');
  },

  updateSalesforceAccount(session: Session, pin: string, input: VaultSalesforceLogin): CredentialSummary {
    requirePin(session, pin);
    return VaultService.saveSalesforceAccount(session, input);
  },

  deleteSalesforceAccount(session: Session, pin: string): CredentialSummary {
    requirePin(session, pin);
    return persistConnectorSlice(session, (creds) => ({ ...creds, salesforce: undefined }), 'Deleted Salesforce login from vault');
  },

  getSalesforceAccount(session: Session): VaultSalesforceLogin | undefined {
    return session.credentials?.salesforce;
  },

  saveDataCloudAccount(session: Session, input: VaultDataCloudLogin): CredentialSummary {
    const login = normalizeDataCloudLogin(input, session.credentials?.dataCloud);
    return persistConnectorSlice(session, (creds) => ({ ...creds, dataCloud: login }), 'Saved Data Cloud login to vault');
  },

  updateDataCloudAccount(session: Session, pin: string, input: VaultDataCloudLogin): CredentialSummary {
    requirePin(session, pin);
    return VaultService.saveDataCloudAccount(session, input);
  },

  deleteDataCloudAccount(session: Session, pin: string): CredentialSummary {
    requirePin(session, pin);
    return persistConnectorSlice(session, (creds) => ({ ...creds, dataCloud: undefined }), 'Deleted Data Cloud login from vault');
  },

  getDataCloudAccount(session: Session): VaultDataCloudLogin | undefined {
    return session.credentials?.dataCloud;
  },

  saveSnowflakeAccount(session: Session, input: VaultSnowflakeLogin): CredentialSummary {
    const login = normalizeSnowflakeLogin(input, session.credentials?.snowflake);
    return persistConnectorSlice(session, (creds) => ({ ...creds, snowflake: login }), 'Saved Snowflake login to vault');
  },

  updateSnowflakeAccount(session: Session, pin: string, input: VaultSnowflakeLogin): CredentialSummary {
    requirePin(session, pin);
    return VaultService.saveSnowflakeAccount(session, input);
  },

  deleteSnowflakeAccount(session: Session, pin: string): CredentialSummary {
    requirePin(session, pin);
    return persistConnectorSlice(session, (creds) => ({ ...creds, snowflake: undefined }), 'Deleted Snowflake login from vault');
  },

  getSnowflakeAccount(session: Session): VaultSnowflakeLogin | undefined {
    return session.credentials?.snowflake;
  },

  /**
   * Fill omitted Salesforce login fields from the vault. Request values win when present.
   * Used by connect/publish routes so the UI can omit secrets.
   */
  mergeSalesforceLogin(
    session: Session,
    body: Partial<VaultSalesforceLogin> | undefined,
  ): VaultSalesforceLogin {
    const saved = session.credentials?.salesforce;
    return {
      url: String(body?.url ?? '').trim() || saved?.url || '',
      username: String(body?.username ?? '').trim() || saved?.username || '',
      password: body?.password ? String(body.password) : saved?.password || '',
      token: String(body?.token ?? '') || saved?.token,
    };
  },

  mergeDataCloudLogin(
    session: Session,
    body: Partial<VaultDataCloudLogin> | undefined,
  ): VaultDataCloudLogin {
    const saved = session.credentials?.dataCloud;
    return {
      url: String(body?.url ?? '').trim() || saved?.url || '',
      clientId: String(body?.clientId ?? '').trim() || saved?.clientId,
      clientSecret: String(body?.clientSecret ?? '') || saved?.clientSecret,
      username: String(body?.username ?? '').trim() || saved?.username,
      password: body?.password !== undefined && body.password !== '' ? String(body.password) : saved?.password,
      token: String(body?.token ?? '') || saved?.token,
    };
  },

  mergeSnowflakeLogin(
    session: Session,
    body: Partial<VaultSnowflakeLogin> | undefined,
  ): VaultSnowflakeLogin {
    const saved = session.credentials?.snowflake;
    return {
      url: String(body?.url ?? '').trim() || saved?.url || '',
      warehouse: String(body?.warehouse ?? '').trim() || saved?.warehouse || '',
      username: String(body?.username ?? '').trim() || saved?.username || '',
      password: body?.password ? String(body.password) : saved?.password || '',
    };
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

/** Keep previously saved connector logins when replacing only the Tableau PAT fields. */
function keepConnectorLogins(existing: TableauCredentials | undefined, incoming: TableauCredentials): TableauCredentials {
  return {
    ...incoming,
    bigQueryOAuth: incoming.bigQueryOAuth ?? existing?.bigQueryOAuth,
    salesforce: incoming.salesforce ?? existing?.salesforce,
    dataCloud: incoming.dataCloud ?? existing?.dataCloud,
    snowflake: incoming.snowflake ?? existing?.snowflake,
  };
}

function requireSavedTableau(session: Session): TableauCredentials {
  if (!session.credentials) {
    throw new AppError('AUTH_REQUIRED', 'Save your Tableau connection details first, then save connector credentials.', {
      hint: 'Save Tableau Cloud credentials in Vault before storing a connector login.',
    });
  }
  return session.credentials;
}

function requirePin(session: Session, pin: string): Buffer {
  const record = getRecord(session.username);
  if (!record) throw new AppError('AUTH_REQUIRED', 'Session user no longer exists.');
  const key = verifyPinOrThrow(record, pin);
  session.vaultKey = key;
  return key;
}

function persistConnectorSlice(
  session: Session,
  mutate: (creds: TableauCredentials) => TableauCredentials,
  message: string,
): CredentialSummary {
  const record = getRecord(session.username);
  if (!record) throw new AppError('AUTH_REQUIRED', 'Session user no longer exists.');
  const current = requireSavedTableau(session);
  const next = mutate(current);
  record.creds = encrypt(session.vaultKey, JSON.stringify(next));
  record.updatedAt = nowIso();
  putRecord(record);
  session.credentials = next;
  log.info(message, { username: session.username });
  return summarizeCredentials(next);
}

function normalizeSalesforceLogin(input: VaultSalesforceLogin, existing?: VaultSalesforceLogin): VaultSalesforceLogin {
  const url = String(input.url ?? '').trim();
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '') || existing?.password || '';
  const token = String(input.token ?? '') || existing?.token;
  if (!url || !username || !password) {
    throw new AppError('VALIDATION', 'Salesforce login URL, username, and password are required.');
  }
  return { url, username, password, ...(token ? { token } : {}) };
}

function normalizeDataCloudLogin(input: VaultDataCloudLogin, existing?: VaultDataCloudLogin): VaultDataCloudLogin {
  const url = String(input.url ?? '').trim();
  const clientId = String(input.clientId ?? '').trim() || existing?.clientId;
  const clientSecret = String(input.clientSecret ?? '') || existing?.clientSecret;
  const username = String(input.username ?? '').trim() || existing?.username;
  const password = String(input.password ?? '') || existing?.password;
  const token = String(input.token ?? '') || existing?.token;
  if (!url) throw new AppError('VALIDATION', 'A Salesforce My Domain URL is required for Data Cloud.');
  if (!clientId && !username) {
    throw new AppError('VALIDATION', 'Save a Connected App consumer key, or a Salesforce username for SOAP login.');
  }
  return {
    url,
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(token ? { token } : {}),
  };
}

function normalizeSnowflakeLogin(input: VaultSnowflakeLogin, existing?: VaultSnowflakeLogin): VaultSnowflakeLogin {
  const url = String(input.url ?? '').trim();
  const warehouse = String(input.warehouse ?? '').trim();
  const username = String(input.username ?? '').trim();
  const password = String(input.password ?? '') || existing?.password || '';
  if (!url || !warehouse || !username || !password) {
    throw new AppError('VALIDATION', 'Snowflake server URL, warehouse, username, and password are required.');
  }
  return { url, warehouse, username, password };
}

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
