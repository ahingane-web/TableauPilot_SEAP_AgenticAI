import React, { useState } from 'react';
import { api } from '../api';
import type { SessionContext } from '../types';
import { ErrorPanel, Busy } from './common';
import {
  Lock,
  User,
  UserPlus,
  Eye,
  EyeOff,
  Shield,
  Clock,
  Document,
  Sparkles,
  Cloud,
  Database,
  Quote,
  HeroIllustration,
} from './icons';

/**
 * Vault identity gate (full-screen login): register (username + 6-digit PIN) or unlock.
 * Presentation only — the register/unlock/session logic is identical to the previous
 * ConnectionPanel; Tableau credentials are saved/edited/deleted in the Vault panel after unlock.
 */
export function LoginView({ onReady }: { onReady: (ctx: SessionContext) => void }): React.ReactElement {
  const [mode, setMode] = useState<'unlock' | 'register'>('unlock');
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
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

  const isRegister = mode === 'register';

  return (
    <div className="login">
      {/* Left: unlock / register form */}
      <div className="login-left">
        <div className="login-card">
          <div className="login-head">
            <span className="tile"><Lock size={22} /></span>
            <div>
              <h2>{isRegister ? 'Create Your Vault' : 'Unlock Your Vault'}</h2>
              <p className="sub">
                {isRegister
                  ? 'Pick a username and a 6-digit PIN to secure your saved Tableau credentials.'
                  : 'Enter your Tableau credentials to decrypt your saved credentials for this session.'}
              </p>
            </div>
          </div>

          <div className="segmented auth-tabs">
            <button type="button" className={!isRegister ? 'on' : ''} onClick={() => setMode('unlock')}>
              <Lock size={15} /> Unlock
            </button>
            <button type="button" className={isRegister ? 'on' : ''} onClick={() => setMode('register')}>
              <UserPlus size={15} /> Register
            </button>
          </div>

          <form className="col" onSubmit={submitIdentity} style={{ gap: 14 }}>
            <div>
              <label>Username</label>
              <div className="field">
                <span className="pfx"><User size={16} /></span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="Enter your Tableau username"
                  required
                />
              </div>
            </div>
            <div>
              <label>6-digit PIN</label>
              <div className="field">
                <span className="pfx"><Lock size={16} /></span>
                <input
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  placeholder="••••••"
                  required
                />
                <button
                  type="button"
                  className="pin-eye"
                  onClick={() => setShowPin((v) => !v)}
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  title={showPin ? 'Hide PIN' : 'Show PIN'}
                >
                  {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <ErrorPanel error={error} />

            <button type="submit" className="block" disabled={busy || pin.length !== 6 || !username}>
              {busy ? <Busy label="Working…" /> : (
                <>
                  <Lock size={16} /> {isRegister ? 'Register & Continue' : 'Unlock Vault'}
                </>
              )}
            </button>
          </form>

          <div className="infobox">
            <span className="ic"><Shield size={16} /></span>
            <span>
              <strong>Your credentials are securely stored and encrypted.</strong>
              <br />
              We only decrypt them for this session to connect to Tableau.
            </span>
          </div>

          <div className="why">
            <div className="why-title">Why use Vault?</div>
            <div className="why-grid">
              <div className="why-item">
                <span className="tile sm ok"><Shield size={16} /></span>
                <div>
                  <div className="t">Secure</div>
                  <div className="c">Encrypted storage</div>
                </div>
              </div>
              <div className="why-item">
                <span className="tile sm brand"><Clock size={16} /></span>
                <div>
                  <div className="t">Your Control</div>
                  <div className="c">Unlocked per session</div>
                </div>
              </div>
              <div className="why-item">
                <span className="tile sm ai"><Document size={16} /></span>
                <div>
                  <div className="t">No Plain Text</div>
                  <div className="c">Credentials never exposed</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right: marketing hero */}
      <aside className="login-hero">
        <div className="hero-inner">
          <span className="hero-badge"><Shield size={14} /> Secure Access</span>
          <h1>
            Connect to <span className="accent">Tableau</span> securely
          </h1>
          <p className="hero-sub">
            Your credentials stay encrypted in the Vault. Unlock to start creating powerful dashboards with AI.
          </p>

          <div className="hero-stage">
            <HeroIllustration className="hero-illus" />
            <span className="chip chip-tl">
              <span className="ic ok"><Shield size={15} /></span>
              <span><strong>Secure</strong><br />Connection</span>
            </span>
            <span className="chip chip-bl">
              <span className="ic ai"><Sparkles size={15} /></span>
              <span><strong>AI-Powered</strong><br />Dashboard Creation</span>
            </span>
            <span className="chip chip-tr">
              <span className="ic brand"><Cloud size={15} /></span>
              <span><strong>Publish to</strong><br />Tableau Cloud</span>
            </span>
            <span className="chip chip-br">
              <span className="ic brand"><Database size={15} /></span>
              <span><strong>Use Your</strong><br />Datasources</span>
            </span>
          </div>

          <div className="quote">
            <span className="qm"><Quote size={26} /></span>
            <p>
              Turn your data into insights. Describe what you need, and let{' '}
              <strong>AI build your Tableau dashboard.</strong>
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
