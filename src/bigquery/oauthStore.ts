/**
 * Transient, in-memory store for in-flight Google (BigQuery) OAuth authorizations.
 *
 * The OAuth callback arrives as a top-level browser redirect from Google and therefore
 * carries NO `x-session-id` header. We map the opaque `state` value back to the
 * originating session (and the PKCE verifier + client details needed to complete the
 * exchange). Entries are short-lived and single-use.
 *
 * Everything here is memory-only and never logged. The client secret is held only for
 * the seconds between authorize and token exchange, then deleted. This mirrors the
 * Salesforce OAuth store (`src/salesforce/oauthStore.ts`) but is kept separate so the
 * Salesforce connector is never touched.
 */
import { logger } from '../utils/logger.js';

const log = logger.child('bigquery:oauth-store');

export interface PendingBigQueryOauth {
  sessionId: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const pending = new Map<string, PendingBigQueryOauth>();

export function putPendingBigQueryOauth(state: string, entry: Omit<PendingBigQueryOauth, 'createdAt'>): void {
  pending.set(state, { ...entry, createdAt: Date.now() });
}

/** Retrieve and DELETE (single-use) a pending authorization by state. */
export function takePendingBigQueryOauth(state: string): PendingBigQueryOauth | undefined {
  const entry = pending.get(state);
  if (!entry) return undefined;
  pending.delete(state);
  if (Date.now() - entry.createdAt > TTL_MS) {
    log.warn('Discarded expired BigQuery OAuth state');
    return undefined;
  }
  return entry;
}

/** Best-effort sweep of expired entries (called from the server bootstrap sweeper). */
export function sweepPendingBigQueryOauth(): void {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(state);
  }
}
