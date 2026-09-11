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
