/**
 * Transient, in-memory store for in-flight Data Cloud OAuth authorizations.
 *
 * Kept separate from `src/salesforce/oauthStore.ts` so Salesforce CRM OAuth
 * completion is unchanged. The Salesforce callback tries this store first (same
 * Connected App redirect URI) and only then the CRM store.
 *
 * Everything here is memory-only and never logged. The client secret is held only
 * for the seconds between authorize and token exchange, then deleted.
 */
import { logger } from '../utils/logger.js';

const log = logger.child('datacloud:oauth-store');

export interface PendingDataCloudOauth {
  sessionId: string;
  loginUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const pending = new Map<string, PendingDataCloudOauth>();

export function putPendingDataCloudOauth(
  state: string,
  entry: Omit<PendingDataCloudOauth, 'createdAt'>,
): void {
  pending.set(state, { ...entry, createdAt: Date.now() });
}

/** Retrieve and DELETE (single-use) a pending authorization by state. */
export function takePendingDataCloudOauth(state: string): PendingDataCloudOauth | undefined {
  const entry = pending.get(state);
  if (!entry) return undefined;
  pending.delete(state);
  if (Date.now() - entry.createdAt > TTL_MS) {
    log.warn('Discarded expired Data Cloud OAuth state');
    return undefined;
  }
  return entry;
}

/** Best-effort sweep of expired entries (called from the server bootstrap sweeper). */
export function sweepPendingDataCloudOauth(): void {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(state);
  }
}
