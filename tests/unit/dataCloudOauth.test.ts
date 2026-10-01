import { describe, it, expect, afterEach } from 'vitest';
import { DataCloudCredentialsSchema } from '../../src/schemas/common.js';
import { buildAuthorizeUrl, DATA_CLOUD_OAUTH_SCOPES } from '../../src/datacloud/oauth.js';
import { putPendingDataCloudOauth, takePendingDataCloudOauth } from '../../src/datacloud/oauthStore.js';

describe('Data Cloud OAuth authorize URL', () => {
  it('requests CDP scopes on the Salesforce authorize URL', () => {
    const url = buildAuthorizeUrl({
      loginUrl: 'https://login.salesforce.com',
      clientId: 'CID',
      redirectUri: 'http://localhost:4000/api/connectors/salesforce/oauth/callback',
      state: 'STATE123',
      codeChallenge: 'CHALLENGE',
    });
    const u = new URL(url);
    expect(u.pathname).toBe('/services/oauth2/authorize');
    expect(u.searchParams.get('client_id')).toBe('CID');
    expect(u.searchParams.get('scope')).toBe(DATA_CLOUD_OAUTH_SCOPES);
    expect(u.searchParams.get('scope')).toBe('api cdp_query_api');
    expect(u.searchParams.get('display')).toBe('popup');
    expect(u.searchParams.get('prompt')).toBeNull();
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('allows an explicit scope override', () => {
    const url = buildAuthorizeUrl({
      loginUrl: 'https://login.salesforce.com',
      clientId: 'CID',
      redirectUri: 'http://localhost:4000/cb',
      state: 'S',
      codeChallenge: 'C',
      scopes: 'api',
    });
    expect(new URL(url).searchParams.get('scope')).toBe('api');
  });
});

describe('Data Cloud OAuth pending store', () => {
  afterEach(() => {
    takePendingDataCloudOauth('dc-test-state');
  });

  it('returns a pending entry once, then undefined', () => {
    putPendingDataCloudOauth('dc-test-state', {
      sessionId: 'sess',
      loginUrl: 'https://login.salesforce.com',
      clientId: 'CID',
      redirectUri: 'http://localhost:4000/cb',
      codeVerifier: 'VERIFIER',
    });
    const first = takePendingDataCloudOauth('dc-test-state');
    expect(first?.sessionId).toBe('sess');
    expect(first?.codeVerifier).toBe('VERIFIER');
    expect(takePendingDataCloudOauth('dc-test-state')).toBeUndefined();
  });
});

describe('DataCloudCredentialsSchema', () => {
  it('allows OAuth credentials without a password', () => {
    const parsed = DataCloudCredentialsSchema.parse({
      url: 'https://login.salesforce.com',
      username: 'user@example.com',
    });
    expect(parsed.password).toBe('');
  });
});
