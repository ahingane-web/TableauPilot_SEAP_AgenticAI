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
import { sweepPendingOauth } from '../salesforce/oauthStore.js';
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
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
