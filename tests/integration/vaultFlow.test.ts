import { describe, it, expect } from 'vitest';
import { VaultService } from '../../src/vault/vault.js';
import { getSession } from '../../src/vault/session.js';
import type { TableauCredentials } from '../../src/vault/types.js';

const creds: TableauCredentials = {
  cloudUrl: 'https://10ax.online.tableau.com',
  siteContentUrl: 'mysite',
  patName: 'pilot',
  patSecret: 'super-secret-pat-value',
  connectedApp: { clientId: 'cid', secretId: 'sid', secretValue: 'sv' },
};

let counter = 0;
const uniqueUser = () => `user_${Date.now()}_${counter++}`;

describe('vault register -> save -> unlock flow', () => {
  it('registers, saves encrypted creds, and unlocks with the right PIN', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '123456');
    expect(reg.hasCredentials).toBe(false);

    const session = getSession(reg.sessionId)!;
    const summary = VaultService.saveCredentials(session, creds);
    // Summary must expose only non-secret facts.
    expect(summary).not.toHaveProperty('patSecret');
    expect(summary.hasPatSecret).toBe(true);
    expect(summary.hasConnectedApp).toBe(true);
    expect(summary.patName).toBe('pilot');

    VaultService.logout(reg.sessionId);

    const unlocked = VaultService.unlock(username, '123456');
    expect(unlocked.hasCredentials).toBe(true);
    const restored = getSession(unlocked.sessionId)!;
    // Decrypted creds are available in-memory server-side after correct PIN.
    expect(VaultService.getCredentials(restored).patSecret).toBe('super-secret-pat-value');
  });

  it('rejects an incorrect PIN without exposing creds', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '111111');
    VaultService.saveCredentials(getSession(reg.sessionId)!, creds);
    expect(() => VaultService.unlock(username, '222222')).toThrow(/incorrect pin/i);
  });

  it('locks the account after too many failed attempts', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '333333');
    VaultService.saveCredentials(getSession(reg.sessionId)!, creds);
    // Default max attempts = 5.
    for (let i = 0; i < 4; i++) {
      expect(() => VaultService.unlock(username, '000000')).toThrow(/incorrect pin/i);
    }
    // 5th failure trips the lockout.
    expect(() => VaultService.unlock(username, '000000')).toThrow(/locked/i);
    // Even the correct PIN is refused while locked.
    expect(() => VaultService.unlock(username, '333333')).toThrow(/try again/i);
  });

  it('refuses to register a duplicate username', () => {
    const username = uniqueUser();
    VaultService.register(username, '444444');
    expect(() => VaultService.register(username, '555555')).toThrow(/already registered/i);
  });

  it('validates PIN format on register', () => {
    expect(() => VaultService.register(uniqueUser(), '12ab56')).toThrow(/6 digits/i);
  });
});

describe('editing credentials requires the PIN', () => {
  it('updates credentials with the correct PIN and resets the live connection', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '246810');
    const session = getSession(reg.sessionId)!;
    VaultService.saveCredentials(session, creds);

    // Simulate an active Tableau connection + flow state.
    session.tableauAuth = {
      token: 'live-token',
      siteId: 'site',
      siteContentUrl: 'mysite',
      userId: 'u',
      serverUrl: 'https://x',
      signedInAt: Date.now(),
    };
    session.flow.datasourceLock = {
      datasourceId: 'd',
      datasourceName: 'DS',
      siteId: 'site',
      lockedAt: new Date().toISOString(),
    };

    const updated: typeof creds = { ...creds, patName: 'rotated', patSecret: 'new-secret', connectedApp: undefined };
    const summary = VaultService.updateCredentials(session, '246810', updated);

    expect(summary.patName).toBe('rotated');
    expect(summary.hasConnectedApp).toBe(false);
    expect(VaultService.getCredentials(session).patSecret).toBe('new-secret');
    // Changing credentials must invalidate the live connection + flow.
    expect(session.tableauAuth).toBeUndefined();
    expect(session.flow.datasourceLock).toBeUndefined();

    // Persisted: a fresh unlock returns the rotated credentials.
    VaultService.logout(reg.sessionId);
    const re = VaultService.unlock(username, '246810');
    expect(getSession(re.sessionId)!.credentials?.patName).toBe('rotated');
  });

  it('rejects a credential edit with the wrong PIN and leaves creds unchanged', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '135790');
    const session = getSession(reg.sessionId)!;
    VaultService.saveCredentials(session, creds);

    expect(() => VaultService.updateCredentials(session, '000000', { ...creds, patName: 'hacker' })).toThrow(/incorrect pin/i);
    // Original credentials remain intact.
    expect(VaultService.getCredentials(session).patName).toBe('pilot');
  });

  it('exposes only a non-secret summary via getCredentialSummary', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '112233');
    const session = getSession(reg.sessionId)!;
    expect(VaultService.getCredentialSummary(session)).toBeNull();
    VaultService.saveCredentials(session, creds);
    const summary = VaultService.getCredentialSummary(session)!;
    expect(summary.hasPatSecret).toBe(true);
    expect(summary).not.toHaveProperty('patSecret');
  });
});

describe('deleting credentials requires the PIN', () => {
  it('deletes credentials with the correct PIN, keeps the vault user, and resets live state', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '246810');
    const session = getSession(reg.sessionId)!;
    VaultService.saveCredentials(session, creds);
    session.tableauAuth = {
      token: 'live-token',
      siteId: 'site',
      siteContentUrl: 'mysite',
      userId: 'u',
      serverUrl: 'https://x',
      signedInAt: Date.now(),
    };
    session.flow.datasourceLock = {
      datasourceId: 'd',
      datasourceName: 'DS',
      siteId: 'site',
      lockedAt: new Date().toISOString(),
    };
    session.connectors = {};

    VaultService.deleteCredentials(session, '246810');

    expect(VaultService.getCredentialSummary(session)).toBeNull();
    expect(session.credentials).toBeUndefined();
    expect(session.connectors).toBeUndefined();
    expect(session.tableauAuth).toBeUndefined();
    expect(session.flow.datasourceLock).toBeUndefined();
    expect(() => VaultService.getCredentials(session)).toThrow(/no tableau credentials/i);

    VaultService.logout(reg.sessionId);
    const re = VaultService.unlock(username, '246810');
    expect(re.hasCredentials).toBe(false);
    expect(getSession(re.sessionId)!.credentials).toBeUndefined();
  });

  it('rejects a credential delete with the wrong PIN and leaves creds unchanged', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '135790');
    const session = getSession(reg.sessionId)!;
    VaultService.saveCredentials(session, creds);

    expect(() => VaultService.deleteCredentials(session, '000000')).toThrow(/incorrect pin/i);
    expect(VaultService.getCredentials(session).patName).toBe('pilot');
  });

  it('allows saving credentials again after a PIN-gated delete', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '998877');
    const session = getSession(reg.sessionId)!;
    VaultService.saveCredentials(session, creds);
    VaultService.deleteCredentials(session, '998877');
    const summary = VaultService.saveCredentials(session, { ...creds, patName: 're-saved' });
    expect(summary.patName).toBe('re-saved');
    expect(VaultService.getCredentials(session).patSecret).toBe('super-secret-pat-value');
  });
});

describe('vault connector login sections', () => {
  function sessionWithTableau() {
    const username = uniqueUser();
    const reg = VaultService.register(username, '121212');
    const session = getSession(reg.sessionId)!;
    VaultService.saveCredentials(session, creds);
    return { username, session, pin: '121212' };
  }

  it('refuses connector logins until Tableau credentials are saved', () => {
    const username = uniqueUser();
    const reg = VaultService.register(username, '343434');
    const session = getSession(reg.sessionId)!;
    expect(() =>
      VaultService.saveSalesforceAccount(session, {
        url: 'https://login.salesforce.com',
        username: 'a@b.com',
        password: 'pw',
      }),
    ).toThrow(/tableau connection details first/i);
  });

  it('saves Salesforce login, hides secrets in the summary, and merges omitted passwords', () => {
    const { session } = sessionWithTableau();
    const summary = VaultService.saveSalesforceAccount(session, {
      url: 'https://login.salesforce.com',
      username: 'a@b.com',
      password: 'sf-secret',
      token: 'tok',
    });
    expect(summary.hasSalesforce).toBe(true);
    expect(summary.salesforceUsername).toBe('a@b.com');
    expect(summary).not.toHaveProperty('password');
    expect(VaultService.getSalesforceAccount(session)?.password).toBe('sf-secret');

    const merged = VaultService.mergeSalesforceLogin(session, {});
    expect(merged.password).toBe('sf-secret');
    expect(merged.username).toBe('a@b.com');
    const override = VaultService.mergeSalesforceLogin(session, { password: 'other' });
    expect(override.password).toBe('other');
  });

  it('keeps Salesforce login when Tableau PAT is updated', () => {
    const { session, pin } = sessionWithTableau();
    VaultService.saveSalesforceAccount(session, {
      url: 'https://login.salesforce.com',
      username: 'a@b.com',
      password: 'sf-secret',
    });
    VaultService.updateCredentials(session, pin, { ...creds, patName: 'rotated' });
    expect(VaultService.getSalesforceAccount(session)?.password).toBe('sf-secret');
    expect(VaultService.getCredentials(session).patName).toBe('rotated');
  });

  it('PIN-deletes Salesforce only and rejects a bad PIN', () => {
    const { session, pin } = sessionWithTableau();
    VaultService.saveSalesforceAccount(session, {
      url: 'https://login.salesforce.com',
      username: 'a@b.com',
      password: 'sf-secret',
    });
    expect(() => VaultService.deleteSalesforceAccount(session, '000000')).toThrow(/incorrect pin/i);
    expect(VaultService.getSalesforceAccount(session)?.username).toBe('a@b.com');
    VaultService.deleteSalesforceAccount(session, pin);
    expect(VaultService.getSalesforceAccount(session)).toBeUndefined();
    expect(VaultService.getCredentials(session).patName).toBe('pilot');
  });

  it('saves Data Cloud and Snowflake logins independently', () => {
    const { session, pin } = sessionWithTableau();
    const dc = VaultService.saveDataCloudAccount(session, {
      url: 'https://org.my.salesforce.com',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    expect(dc.hasDataCloud).toBe(true);
    expect(dc.dataCloudClientId).toBe('cid');
    expect(dc).not.toHaveProperty('clientSecret');

    const sn = VaultService.saveSnowflakeAccount(session, {
      url: 'xy12345.snowflakecomputing.com',
      warehouse: 'COMPUTE_WH',
      username: 'sfuser',
      password: 'snow-secret',
    });
    expect(sn.hasSnowflake).toBe(true);
    expect(sn.snowflakeWarehouse).toBe('COMPUTE_WH');
    expect(VaultService.mergeSnowflakeLogin(session, {}).password).toBe('snow-secret');

    VaultService.deleteDataCloudAccount(session, pin);
    expect(VaultService.getDataCloudAccount(session)).toBeUndefined();
    expect(VaultService.getSnowflakeAccount(session)?.username).toBe('sfuser');
  });

  it('PIN-deletes the BigQuery OAuth client without wiping Tableau', () => {
    const { session, pin } = sessionWithTableau();
    VaultService.saveBigQueryOAuthClient(session, { clientId: 'bq-client', clientSecret: 'bq-secret' });
    expect(VaultService.getBigQueryOAuthClient(session).clientId).toBe('bq-client');
    expect(() => VaultService.deleteBigQueryOAuthClient(session, '000000')).toThrow(/incorrect pin/i);
    VaultService.deleteBigQueryOAuthClient(session, pin);
    expect(VaultService.getBigQueryOAuthClient(session).clientId).toBeUndefined();
    expect(VaultService.getCredentials(session).patSecret).toBe('super-secret-pat-value');
  });
});
