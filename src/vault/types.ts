/**
 * Vault + session domain types.
 *
 * `TableauCredentials` is the ONLY place raw Tableau secrets exist in app types.
 * Instances live either (a) encrypted at rest in the vault, or (b) decrypted in a
 * server-side session held in memory. They are never serialized to the client,
 * the LLM, memory, workflow state, logs, or traces.
 */
import type { EncryptedBlob } from './crypto.js';

/** Raw per-user Tableau secrets. NEVER leaves the server process boundary. */
export interface TableauCredentials {
  /** e.g. https://10ax.online.tableau.com */
  cloudUrl: string;
  /** Tableau Cloud site content URL (the slug in the site URL). */
  siteContentUrl: string;
  /** Personal Access Token name (for REST API sign-in). */
  patName: string;
  /** Personal Access Token secret. */
  patSecret: string;
  /** Optional Connected App (Direct Trust) for embedded Web Authoring JWTs. */
  connectedApp?: {
    clientId: string;
    secretId: string;
    secretValue: string;
  };
  /**
   * Optional saved Google OAuth *client* (id + optional secret) for the BigQuery connector's
   * browser sign-in, so the user does not re-enter it each time. This is the APP registration
   * credential (like `connectedApp`), NOT the per-user access/refresh token — that token is
   * still held only transiently in-memory and never persisted.
   */
  bigQueryOAuth?: {
    clientId: string;
    clientSecret?: string;
  };
}

/** Non-secret summary of what a user has saved — safe to send to the client. */
export interface CredentialSummary {
  cloudUrl: string;
  siteContentUrl: string;
  patName: string;
  hasPatSecret: boolean;
  hasConnectedApp: boolean;
  connectedAppClientId?: string;
  /** Whether a Google BigQuery OAuth client is saved in the vault (+ its non-secret client id). */
  hasBigQueryOAuth: boolean;
  bigQueryOAuthClientId?: string;
  bigQueryOAuthHasSecret?: boolean;
}

/** On-disk vault record. `creds`/`verifier` are encrypted; nothing here is plaintext-secret. */
export interface VaultRecord {
  username: string;
  saltHex: string;
  verifier: EncryptedBlob;
  creds: EncryptedBlob | null;
  createdAt: string;
  updatedAt: string;
  failedAttempts: number;
  lockedUntil: number | null;
}

export function summarizeCredentials(creds: TableauCredentials): CredentialSummary {
  return {
    cloudUrl: creds.cloudUrl,
    siteContentUrl: creds.siteContentUrl,
    patName: creds.patName,
    hasPatSecret: Boolean(creds.patSecret),
    hasConnectedApp: Boolean(creds.connectedApp?.secretValue),
    connectedAppClientId: creds.connectedApp?.clientId,
    hasBigQueryOAuth: Boolean(creds.bigQueryOAuth?.clientId),
    bigQueryOAuthClientId: creds.bigQueryOAuth?.clientId,
    bigQueryOAuthHasSecret: Boolean(creds.bigQueryOAuth?.clientSecret),
  };
}
