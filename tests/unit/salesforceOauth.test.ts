import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchUserInfo,
  sessionFromToken,
} from '../../src/salesforce/oauth.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generatePkce', () => {
  it('produces a url-safe verifier and S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toEqual(challenge);
  });
  it('generateState is url-safe and non-empty', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds a Salesforce authorize URL with PKCE + state', () => {
    const url = buildAuthorizeUrl({
      loginUrl: 'https://login.salesforce.com',
      clientId: 'CID',
      redirectUri: 'http://localhost:4000/api/connectors/salesforce/oauth/callback',
      state: 'STATE123',
      codeChallenge: 'CHALLENGE',
    });
    const u = new URL(url);
    expect(u.origin).toBe('https://login.salesforce.com');
    expect(u.pathname).toBe('/services/oauth2/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('CID');
    expect(u.searchParams.get('redirect_uri')).toBe(
      'http://localhost:4000/api/connectors/salesforce/oauth/callback',
    );
    expect(u.searchParams.get('state')).toBe('STATE123');
    expect(u.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('exchangeCodeForToken', () => {
  it('exchanges a code and returns access token + instance origin', async () => {
    const captured: { url?: string; body?: string } = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured.url = url;
        captured.body = String(init.body);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              access_token: 'ACCESS',
              refresh_token: 'REFRESH',
              instance_url: 'https://mydomain.my.salesforce.com',
            }),
        };
      }) as unknown as typeof fetch,
    );
    const result = await exchangeCodeForToken({
      loginUrl: 'https://login.salesforce.com',
      clientId: 'CID',
      clientSecret: 'CSECRET',
      redirectUri: 'http://localhost:4000/cb',
      code: 'AUTHCODE',
      codeVerifier: 'VERIFIER',
    });
    expect(result.accessToken).toBe('ACCESS');
    expect(result.refreshToken).toBe('REFRESH');
    expect(result.instanceUrl).toBe('https://mydomain.my.salesforce.com');
    expect(captured.url).toBe('https://login.salesforce.com/services/oauth2/token');
    expect(captured.body).toContain('grant_type=authorization_code');
    expect(captured.body).toContain('code_verifier=VERIFIER');
    expect(captured.body).toContain('client_secret=CSECRET');
  });

  it('throws AUTH_FAILED with the error_description on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'expired authorization code' }),
      })) as unknown as typeof fetch,
    );
    await expect(
      exchangeCodeForToken({
        loginUrl: 'https://login.salesforce.com',
        clientId: 'CID',
        redirectUri: 'http://localhost:4000/cb',
        code: 'BAD',
        codeVerifier: 'V',
      }),
    ).rejects.toThrow(/token exchange failed/);
  });
});

describe('fetchUserInfo + sessionFromToken', () => {
  it('reads the preferred_username and builds a session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ preferred_username: 'user@example.com' }),
      })) as unknown as typeof fetch,
    );
    const token = { accessToken: 'ACCESS', instanceUrl: 'https://mydomain.my.salesforce.com' };
    const info = await fetchUserInfo(token);
    expect(info.username).toBe('user@example.com');
    // The mocked fetch returns a non-array for /services/data/, so version resolution
    // falls back to the default SOAP API version.
    const session = await sessionFromToken(token);
    expect(session).toEqual({ instanceUrl: 'https://mydomain.my.salesforce.com', accessToken: 'ACCESS', apiVersion: '59.0' });
  });
});
