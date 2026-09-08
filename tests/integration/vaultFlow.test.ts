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
