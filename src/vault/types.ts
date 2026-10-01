/**
 * Vault + session domain types.
 *
 * `TableauCredentials` is the encrypted-at-rest blob: Tableau PAT/Connected App plus
 * optional connector *login materials* (Salesforce, BigQuery OAuth client, Data Cloud,
 * Snowflake). Live connector *tokens* never live here. Instances live either
 * (a) encrypted at rest in the vault, or (b) decrypted in a server-side session.
 * They are never serialized to the client, the LLM, memory, workflow state, logs, or traces.
 */
import type { EncryptedBlob } from './crypto.js';

/** Salesforce username/password login materials (not a live SOAP/OAuth session). */
export interface VaultSalesforceLogin {
  url: string;
  username: string;
  password: string;
  token?: string;
}

/** Data Cloud Connected App + optional SOAP login (not a live CDP token). */
export interface VaultDataCloudLogin {
  url: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  token?: string;
}

/** Snowflake username/password login (not a live session token). */
export interface VaultSnowflakeLogin {
  url: string;
  warehouse: string;
  username: string;
  password: string;
}

/** Raw per-user secrets. NEVER leaves the server process boundary. */
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
  /** Optional Salesforce login materials for the Build-datasource connector. */
  salesforce?: VaultSalesforceLogin;
  /** Optional Data Cloud Connected App + SOAP login materials. */
  dataCloud?: VaultDataCloudLogin;
  /** Optional Snowflake login materials. */
  snowflake?: VaultSnowflakeLogin;
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
  hasSalesforce: boolean;
  salesforceUrl?: string;
  salesforceUsername?: string;
  salesforceHasPassword?: boolean;
  hasDataCloud: boolean;
  dataCloudUrl?: string;
  dataCloudClientId?: string;
  dataCloudHasClientSecret?: boolean;
  dataCloudUsername?: string;
  dataCloudHasPassword?: boolean;
  hasSnowflake: boolean;
  snowflakeUrl?: string;
  snowflakeWarehouse?: string;
  snowflakeUsername?: string;
  snowflakeHasPassword?: boolean;
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
  const sf = creds.salesforce;
  const dc = creds.dataCloud;
  const sn = creds.snowflake;
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
    hasSalesforce: Boolean(sf?.url && sf.username && sf.password),
    salesforceUrl: sf?.url,
    salesforceUsername: sf?.username,
    salesforceHasPassword: Boolean(sf?.password),
    hasDataCloud: Boolean(dc?.url && (dc.clientId || dc.username)),
    dataCloudUrl: dc?.url,
    dataCloudClientId: dc?.clientId,
    dataCloudHasClientSecret: Boolean(dc?.clientSecret),
    dataCloudUsername: dc?.username,
    dataCloudHasPassword: Boolean(dc?.password),
    hasSnowflake: Boolean(sn?.url && sn.warehouse && sn.username && sn.password),
    snowflakeUrl: sn?.url,
    snowflakeWarehouse: sn?.warehouse,
    snowflakeUsername: sn?.username,
    snowflakeHasPassword: Boolean(sn?.password),
  };
}
