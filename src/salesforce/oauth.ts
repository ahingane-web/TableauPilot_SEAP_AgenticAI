/**
 * Salesforce OAuth 2.0 Authorization Code flow (with PKCE) for interactive
 * "browser sign-in" connector authentication.
 *
 * The agent opens the authorize URL in a popup; Salesforce redirects back to our
 * callback with a `code`; we exchange it for an access token here. Pure `fetch` +
 * Node `crypto`; no external dependency.
 *
 * Security: client secret, authorization code, tokens, and PKCE verifier are never
 * logged. Tokens live in memory only (on the session's transient connector state).
 */
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';
import { normalizeLoginUrl, SALESFORCE_API_VERSION, type SalesforceSession } from './client.js';

const log = logger.child('salesforce:oauth');

/** Default OAuth scopes: `api` to call the REST API, `refresh_token` for longevity. */
const DEFAULT_SCOPES = 'api refresh_token';

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
  loginUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}

/** Build the Salesforce authorize URL the popup should navigate to. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const origin = normalizeLoginUrl(input.loginUrl);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes ?? DEFAULT_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    // Force the account chooser/consent so a wrong cached session isn't reused silently.
    prompt: 'login',
  });
  return `${origin}/services/oauth2/authorize?${params.toString()}`;
}

export interface ExchangeCodeInput {
  loginUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export interface SalesforceTokenResult {
  accessToken: string;
  refreshToken?: string;
  instanceUrl: string;
}

/** Exchange an authorization code for an access token. */
export async function exchangeCodeForToken(input: ExchangeCodeInput): Promise<SalesforceTokenResult> {
  const origin = normalizeLoginUrl(input.loginUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);

  let res: Response;
  try {
    res = await fetch(`${origin}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Salesforce: ${redactString(String(err))}`);
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
    throw new AppError('AUTH_FAILED', `Salesforce OAuth token exchange failed: ${redactString(message)}`, {
      hint: 'Verify the Connected App consumer key/secret and that the exact callback URL is registered on the app.',
    });
  }
  let parsed: { access_token?: string; refresh_token?: string; instance_url?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('CONNECTOR_API', 'Unexpected non-JSON response from Salesforce token endpoint.');
  }
  if (!parsed.access_token || !parsed.instance_url) {
    throw new AppError('AUTH_FAILED', 'Salesforce OAuth did not return an access token.');
  }
  log.info('Salesforce OAuth token exchange succeeded', { instanceHost: new URL(parsed.instance_url).host });
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    instanceUrl: new URL(parsed.instance_url).origin,
  };
}

/** Fetch the authenticated user's identity (for the connection username). */
export async function fetchUserInfo(token: SalesforceTokenResult): Promise<{ username: string }> {
  let res: Response;
  try {
    res = await fetch(`${token.instanceUrl}/services/oauth2/userinfo`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Salesforce: ${redactString(String(err))}`);
  }
  if (!res.ok) {
    throw new AppError('CONNECTOR_API', 'Could not read Salesforce user info after OAuth.');
  }
  const info = (await res.json().catch(() => ({}))) as { preferred_username?: string; email?: string; name?: string };
  const username = info.preferred_username ?? info.email ?? info.name ?? '';
  return { username };
}

/** Build a {@link SalesforceSession} from an OAuth token result. */
export function sessionFromToken(token: SalesforceTokenResult): SalesforceSession {
  return { instanceUrl: token.instanceUrl, accessToken: token.accessToken, apiVersion: SALESFORCE_API_VERSION };
}
