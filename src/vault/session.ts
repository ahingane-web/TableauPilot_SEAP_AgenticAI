/**
 * In-memory server-side session manager.
 *
 * A session is created when a user unlocks their vault. It holds — in memory only —
 * the derived vault key (to re-encrypt saved creds), the decrypted Tableau
 * credentials, the live Tableau REST auth token, and the app's workflow context
 * (selected project, datasource lock, plan, approval). None of this is persisted,
 * logged, or sent to the browser. The browser only ever holds an opaque session id.
 */
import { randomBytes } from 'node:crypto';
import { getConfig } from '../config/env.js';
import type { DatasourceLock, TableauProjectContext } from '../schemas/common.js';
import type { DashboardPlan } from '../schemas/dashboardPlan.js';
import type { SalesforceCredentials, SalesforceSession, SalesforceTable } from '../salesforce/client.js';
import type { ExcelSheet } from '../excel/excelClient.js';
import type { SnowflakeAuth, SnowflakeCredentials } from '../snowflake/client.js';
import { sweepPendingOauth } from '../salesforce/oauthStore.js';
import { sweepPendingBigQueryOauth } from '../bigquery/oauthStore.js';
import { sweepPendingDataCloudOauth } from '../datacloud/oauthStore.js';
import type { DatasourceMetadata } from '../tableau/types.js';
import type { TableauCredentials } from './types.js';

/**
 * Transient connector state for the "Build datasource" flow. Secret material
 * (credentials, access token) is memory-only, never persisted, logged, or sent to
 * the client. Cleared once the datasource is published (or on logout).
 */
export interface ConnectorState {
  salesforce?: {
    /** Raw credentials — kept only for the duration of the build to embed on publish. */
    creds: SalesforceCredentials;
    /** Live Salesforce session (instance URL + access token). */
    sfSession: SalesforceSession;
    /** Objects listed for the user to choose from. */
    tables: SalesforceTable[];
  };
  /**
   * Transient Excel upload state for the "Build datasource" flow. The uploaded workbook is
   * parsed once (sheets + schema + rows) and held here — memory only — until the datasource
   * is published (or the session is cleared). Non-secret, but never sent wholesale to the
   * client (only sheet/column identity is exposed).
   */
  excel?: {
    /** Opaque id for the current upload (lets the client confirm which workbook is active). */
    uploadId: string;
    /** Original uploaded file name (basename) — used for the `excel-direct` `filename`. */
    filename: string;
    /** Parsed worksheets: identifier-safe id + caption + typed columns + coerced rows. */
    sheets: ExcelSheet[];
  };
  /**
   * Transient Google BigQuery OAuth state for the "Build datasource" flow. The Google
   * access/refresh token (obtained via browser sign-in) is held here — memory only — so
   * subsequent listing (projects/datasets/tables) + the extract's row queries can call the
   * BigQuery REST API, and so a LIVE datasource can embed the OAuth credential on publish.
   * Cleared once the datasource is published (or the session is cleared). Never persisted,
   * logged, or sent to the client (only the email is surfaced, for the connection username).
   */
  bigquery?: {
    /** Signed-in Google account email — the BigQuery connection `username` (non-secret). */
    email: string;
    /** OAuth access token (Bearer for BigQuery/Cloud Resource Manager REST). Secret. */
    accessToken: string;
    /** OAuth refresh token, if Google returned one (long sessions). Secret. */
    refreshToken?: string;
    /** Epoch ms when the access token expires (best-effort; triggers a refresh). */
    expiresAt?: number;
    /** OAuth client id used for this flow (needed to refresh the access token). */
    clientId: string;
    /** OAuth client secret, if the flow used a confidential client (needed to refresh). Secret. */
    clientSecret?: string;
  };
  /**
   * Transient Salesforce Data Cloud (Genie) state. Core SOAP or OAuth session + CDP
   * token are memory-only, used to list data spaces/objects and (for extracts) query
   * rows, then cleared after publish. Never persisted, logged, or sent to the client.
   */
  datacloud?: {
    creds: SalesforceCredentials;
    sfSession: SalesforceSession;
    cdp: {
      accessToken: string;
      instanceUrl: string;
      coreInstanceUrl: string;
      coreAccessToken: string;
      apiVersion: string;
      tenantId: string;
      pod: string;
      /** Data space the CDP token was issued for (`dataspace=` on the a360 exchange). */
      dataSpace?: string;
    };
  };
  /**
   * Transient Snowflake state. Session token + password are memory-only, used to list
   * warehouses/databases/schemas/tables and (for extracts) query rows, then cleared after
   * publish. Never persisted, logged, or sent to the client.
   */
  snowflake?: {
    creds: SnowflakeCredentials;
    auth: SnowflakeAuth;
  };
}

/** Live Tableau REST authentication — short-lived, secret, memory-only. */
export interface TableauAuthState {
  token: string;
  siteId: string;
  siteContentUrl: string;
  userId: string;
  serverUrl: string;
  signedInAt: number;
}

/** Non-secret application context accumulated during a flow. */
export interface FlowContext {
  projectContext?: TableauProjectContext;
  datasourceLock?: DatasourceLock;
  /**
   * Datasource field metadata captured at build time (e.g. from a Salesforce
   * `describe`), keyed by datasourceId. Non-secret. Lets the dashboard flow use real
   * fields immediately instead of waiting on Tableau's async Metadata API indexing.
   */
  connectorMetadata?: Record<string, DatasourceMetadata>;
  plan?: DashboardPlan;
  approvedPlanHash?: string;
  workbook?: {
    workbookId: string;
    name: string;
    webpageUrl?: string;
    contentUrl?: string;
  };
}

export interface Session {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
  /** Derived vault key — memory only, used to re-encrypt saved creds. */
  vaultKey: Buffer;
  /** Decrypted Tableau credentials — memory only. */
  credentials?: TableauCredentials;
  /** Live Tableau REST auth — memory only. */
  tableauAuth?: TableauAuthState;
  /** Transient connector build state (e.g. Salesforce) — memory only. */
  connectors?: ConnectorState;
  flow: FlowContext;
}

const sessions = new Map<string, Session>();

function ttlMs(): number {
  return getConfig().vault.sessionTtlSeconds * 1000;
}

export function createSession(username: string, vaultKey: Buffer, credentials?: TableauCredentials): Session {
  const id = randomBytes(24).toString('base64url');
  const now = Date.now();
  const session: Session = {
    id,
    username,
    createdAt: now,
    expiresAt: now + ttlMs(),
    vaultKey,
    credentials,
    flow: {},
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string | undefined | null): Session | undefined {
  if (!id) return undefined;
  const s = sessions.get(id);
  if (!s) return undefined;
  if (s.expiresAt < Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return s;
}

export function touchSession(id: string): void {
  const s = sessions.get(id);
  if (s) s.expiresAt = Date.now() + ttlMs();
}

export function destroySession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    // Best-effort scrub of secret material.
    s.vaultKey.fill(0);
    s.credentials = undefined;
    s.tableauAuth = undefined;
    s.connectors = undefined;
  }
  sessions.delete(id);
}

/** Periodic cleanup of expired sessions (called from the server bootstrap). */
export function startSessionSweeper(intervalMs = 60_000): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.expiresAt < now) destroySession(id);
    }
    sweepPendingOauth();
    sweepPendingBigQueryOauth();
    sweepPendingDataCloudOauth();
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
