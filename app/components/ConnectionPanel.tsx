import React, { useState } from 'react';
import { api } from '../api';
import type { SessionContext } from '../types';
import { ErrorPanel, Busy } from './common';

/**
 * Identity + credential gate.
 *  - Register (new user, sets a 6-digit PIN) OR Unlock (existing user, enters PIN).
 *  - Then save Tableau credentials (encrypted server-side under the PIN).
 * The PIN and secrets are POSTed once and never stored client-side.
 */
export function ConnectionPanel({ onReady }: { onReady: (ctx: SessionContext) => void }): React.ReactElement {
  const [mode, setMode] = useState<'unlock' | 'register'>('unlock');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [session, setSession] = useState<SessionContext | null>(null);
  const [needCreds, setNeedCreds] = useState(false);

  // Credential form
  const [cloudUrl, setCloudUrl] = useState('');
  const [siteContentUrl, setSiteContentUrl] = useState('');
  const [patName, setPatName] = useState('');
  const [patSecret, setPatSecret] = useState('');
  const [useCA, setUseCA] = useState(false);
  const [caClientId, setCaClientId] = useState('');
  const [caSecretId, setCaSecretId] = useState('');
  const [caSecretValue, setCaSecretValue] = useState('');

  async function submitIdentity(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = mode === 'register' ? await api.register(username, pin) : await api.unlock(username, pin);
      const ctx = await api.session();
      setSession(ctx);
      if (!res.hasCredentials) {
        setNeedCreds(true);
      } else {
        onReady(ctx);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveCreds(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.saveCredentials({
        cloudUrl,
        siteContentUrl,
        patName,
        patSecret,
        connectedApp: useCA ? { clientId: caClientId, secretId: caSecretId, secretValue: caSecretValue } : undefined,
      });
      const ctx = await api.session();
      setSession(ctx);
      onReady(ctx);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (needCreds && session) {
    return (
      <div className="panel">
        <h2>Save Tableau Cloud credentials</h2>
        <p className="hint">
          These are encrypted with your PIN and stored server-side. They are never sent back to the browser.
        </p>
        <form className="col" onSubmit={saveCreds}>
          <div>
            <label>Tableau Cloud URL</label>
            <input placeholder="https://10ax.online.tableau.com" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} required />
          </div>
          <div>
            <label>Site content URL (site slug)</label>
            <input placeholder="your-site" value={siteContentUrl} onChange={(e) => setSiteContentUrl(e.target.value)} required />
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Personal Access Token name</label>
              <input value={patName} onChange={(e) => setPatName(e.target.value)} required />
            </div>
            <div style={{ flex: 1 }}>
              <label>Personal Access Token secret</label>
              <input type="password" value={patSecret} onChange={(e) => setPatSecret(e.target.value)} required />
            </div>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={useCA} onChange={(e) => setUseCA(e.target.checked)} />
            <span>Add a Connected App for seamless embedded Web Authoring (optional)</span>
          </label>
          {useCA ? (
            <div className="col">
              <div>
                <label>Connected App Client ID</label>
                <input value={caClientId} onChange={(e) => setCaClientId(e.target.value)} />
              </div>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <label>Secret ID</label>
                  <input value={caSecretId} onChange={(e) => setCaSecretId(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label>Secret Value</label>
                  <input type="password" value={caSecretValue} onChange={(e) => setCaSecretValue(e.target.value)} />
                </div>
              </div>
            </div>
          ) : (
            <p className="hint">Without a Connected App, the embedded authoring iframe will prompt for interactive Tableau login.</p>
          )}
          <ErrorPanel error={error} />
          <div className="row">
            <button type="submit" disabled={busy}>
              {busy ? <Busy label="Saving…" /> : 'Save & continue'}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>{mode === 'register' ? 'Create your vault' : 'Unlock your vault'}</h2>
      <div className="steps">
        <span className={`step ${mode === 'unlock' ? 'active' : ''}`} onClick={() => setMode('unlock')} style={{ cursor: 'pointer' }}>
          Unlock
        </span>
        <span className={`step ${mode === 'register' ? 'active' : ''}`} onClick={() => setMode('register')} style={{ cursor: 'pointer' }}>
          Register
        </span>
      </div>
      <form className="col" onSubmit={submitIdentity}>
        <div>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </div>
        <div>
          <label>6-digit PIN</label>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            placeholder="••••••"
            required
          />
        </div>
        <ErrorPanel error={error} />
        <div className="row">
          <button type="submit" disabled={busy || pin.length !== 6 || !username}>
            {busy ? <Busy label="Working…" /> : mode === 'register' ? 'Register & continue' : 'Unlock'}
          </button>
        </div>
      </form>
      <p className="hint">
        {mode === 'register'
          ? 'Pick a username and a 6-digit PIN. You will use them to unlock your saved Tableau credentials next time.'
          : 'Enter your username and PIN to decrypt your saved Tableau credentials for this session.'}
      </p>
    </div>
  );
}
