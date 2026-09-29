/**
 * Google OAuth 2.0 Authorization Code flow (with PKCE) for interactive "browser sign-in"
 * BigQuery connector authentication.
 *
 * The agent opens the authorize URL in a popup; Google redirects back to our callback
 * with a `code`; we exchange it for an access token (+ refresh token) here. The access
 * token is then used as a Bearer token against the BigQuery + Cloud Resource Manager REST
 * APIs (see `client.ts`) to list projects/datasets/tables and query rows for the extract.
 *
 * Pure `fetch` + Node `crypto`; no external dependency. Structurally mirrors the
 * Salesforce OAuth module (`src/salesforce/oauth.ts`) but is kept independent so the
 * Salesforce connector is never touched.
 *
 * Security: client secret, authorization code, tokens, and PKCE verifier are never logged.
 * Tokens live in memory only (on the session's transient connector state).
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';

const log = logger.child('bigquery:oauth');

/** Google OAuth 2.0 endpoints. */
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Default OAuth scopes — deliberately mirror Tableau Desktop's own BigQuery connector
 * (least privilege + proven-compatible with Tableau Cloud's saved BigQuery credential):
 *  - `openid email`: read the signed-in Google account email (the connection username).
 *  - `bigquery`: read schema + run query jobs (list datasets/tables, query rows for extracts).
 *  - `cloudplatformprojects.readonly`: enumerate the account's GCP projects (billing + data)
 *    via Cloud Resource Manager `projects.list`. This is narrower than `cloud-platform.read-only`
 *    (which grants read across ALL Cloud services) — it authorizes project listing and nothing
 *    more, exactly what this connector needs.
 */
const DEFAULT_SCOPES =
  'openid email https://www.googleapis.com/auth/bigquery https://www.googleapis.com/auth/cloudplatformprojects.readonly';

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Base64url without padding. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE verifier + S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** A random opaque value for the OAuth `state` (CSRF protection + callback routing). */
export function generateState(): string {
  return base64url(randomBytes(24));
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}

/** Build the Google authorize URL the popup should navigate to. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes ?? DEFAULT_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    // `offline` + `consent` ensure we receive a refresh_token (Google only returns one on
    // the first consent unless prompt=consent is forced), so long sessions can refresh.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

export interface ExchangeCodeInput {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export interface GoogleTokenResult {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (best-effort; from `expires_in`). */
  expiresAt?: number;
}

async function postToken(body: URLSearchParams): Promise<GoogleTokenResult> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Google: ${redactString(String(err))}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error_description || parsed?.error) {
        message = String(parsed.error_description ?? parsed.error);
      }
    } catch {
      /* keep default */
    }
    throw new AppError('AUTH_FAILED', `Google OAuth token exchange failed: ${redactString(message)}`, {
      hint: 'Verify the Google OAuth client id/secret and that the exact callback URL is registered as an Authorized redirect URI.',
    });
  }
  let parsed: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('CONNECTOR_API', 'Unexpected non-JSON response from Google token endpoint.');
  }
  if (!parsed.access_token) {
    throw new AppError('AUTH_FAILED', 'Google OAuth did not return an access token.');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_in ? Date.now() + parsed.expires_in * 1000 : undefined,
  };
}

/** Exchange an authorization code for an access token (+ refresh token). */
export async function exchangeCodeForToken(input: ExchangeCodeInput): Promise<GoogleTokenResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const token = await postToken(body);
  log.info('Google OAuth token exchange succeeded', { hasRefresh: Boolean(token.refreshToken) });
  return token;
}

/** Refresh an access token using a stored refresh token (for long-running sessions). */
export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<GoogleTokenResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const token = await postToken(body);
  // A refresh response usually omits a new refresh_token; keep the caller's existing one.
  return { ...token, refreshToken: token.refreshToken ?? input.refreshToken };
}

/** Fetch the authenticated user's email (for the connection username). Best-effort. */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(USERINFO_ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch {
    return '';
  }
  if (!res.ok) return '';
  const info = (await res.json().catch(() => ({}))) as { email?: string; sub?: string };
  return info.email ?? '';
}
