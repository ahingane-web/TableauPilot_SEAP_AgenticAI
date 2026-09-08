/**
 * Tool execution context helpers.
 *
 * Tools NEVER receive credentials as arguments. Instead the server injects an
 * opaque `sessionId` into the Mastra requestContext; tools resolve the server-side
 * Session from it and operate through TableauService. This keeps every secret out
 * of tool inputs, model context, and traces.
 */
import { AppError } from '../utils/errors.js';
import { VaultService } from '../vault/vault.js';
import type { Session } from '../vault/session.js';

/** Read the sessionId from the Mastra requestContext (supports a few shapes). */
export function readSessionId(ctx: unknown): string | undefined {
  const rc = (ctx as { requestContext?: unknown } | undefined)?.requestContext as
    | { get?: (k: string) => unknown; sessionId?: unknown }
    | undefined;
  if (!rc) return undefined;
  const viaGet = typeof rc.get === 'function' ? rc.get('sessionId') : undefined;
  const value = viaGet ?? rc.sessionId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Resolve the live Session for a tool call, or throw an actionable error. */
export function requireSessionFromContext(ctx: unknown): Session {
  const sessionId = readSessionId(ctx);
  if (!sessionId) {
    throw new AppError('AUTH_REQUIRED', 'No active session. Unlock your vault and connect to Tableau Cloud first.', {
      hint: 'In Mastra Studio, set requestContext.sessionId to a valid unlocked session.',
    });
  }
  return VaultService.requireSession(sessionId);
}
