/**
 * Salesforce Data Cloud OAuth 2.0 Authorization Code + PKCE wrapper.
 *
 * Data Cloud's `/services/a360/token` exchange requires a core OAuth access token
 * with `api` + `cdp_query_api`. A SOAP session id is not a valid `subject_token`
 * on many orgs (empty-body HTTP 500). Extra scopes (`refresh_token`, `cdp_profile_api`)
 * are omitted: requesting a scope the Connected App does not list causes
 * `OAUTH_APPROVAL_ERROR_GENERIC`. `prompt=login` is omitted so My Domain can render
 * the login/consent page in a popup (`display=popup` instead).
 *
 * PKCE / token exchange helpers are imported from `src/salesforce/oauth.ts`; that
 * file's internals are not modified. The authorize URL is built here so Data Cloud
 * does not inherit CRM Salesforce `prompt=login`.
 */
import { normalizeLoginUrl } from '../salesforce/client.js';
import * as SalesforceOauth from '../salesforce/oauth.js';

/** Minimum scopes for REST + Data Cloud a360 token exchange. */
export const DATA_CLOUD_OAUTH_SCOPES = 'api cdp_query_api';

export interface DataCloudAuthorizeUrlInput {
  loginUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
}

/** Build the Salesforce authorize URL with Data Cloud CDP scopes. */
export function buildAuthorizeUrl(input: DataCloudAuthorizeUrlInput): string {
  const origin = normalizeLoginUrl(input.loginUrl);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes ?? DATA_CLOUD_OAUTH_SCOPES,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    display: 'popup',
  });
  return `${origin}/services/oauth2/authorize?${params.toString()}`;
}

export const generatePkce = SalesforceOauth.generatePkce;
export const generateState = SalesforceOauth.generateState;
export const exchangeCodeForToken = SalesforceOauth.exchangeCodeForToken;
export const fetchUserInfo = SalesforceOauth.fetchUserInfo;
export const sessionFromToken = SalesforceOauth.sessionFromToken;
