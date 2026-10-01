import React, { useState } from 'react';
import { api } from '../api';
import type { SessionContext } from '../types';
import { ErrorPanel, Busy } from './common';

/**
 * Vault identity gate: register (username + 6-digit PIN) or unlock. Tableau
 * credentials are saved/edited/deleted in the Vault panel after unlock.
 */
export function ConnectionPanel({ onReady }: { onReady: (ctx: SessionContext) => void }): React.ReactElement {
  const [mode, setMode] = useState<'unlock' | 'register'>('unlock');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submitIdentity(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'register') await api.register(username, pin);
      else await api.unlock(username, pin);
      onReady(await api.session());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
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
