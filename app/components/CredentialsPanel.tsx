import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { CredentialSummary, SessionContext } from '../types';
import { Busy, ErrorPanel } from './common';

/**
 * View and EDIT saved Tableau credentials after login. Editing requires the user to
 * re-enter their 6-digit PIN (secrets are never returned to the browser, so secret
 * fields must be re-entered on change). Saving invalidates the live connection so the
 * user reconnects with the new credentials.
 */
export function CredentialsPanel({
  ctx,
  onChange,
}: {
  ctx: SessionContext;
  onChange: (ctx: SessionContext) => void;
}): React.ReactElement {
  const [summary, setSummary] = useState<CredentialSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Form state
  const [pin, setPin] = useState('');
  const [cloudUrl, setCloudUrl] = useState('');
  const [siteContentUrl, setSiteContentUrl] = useState('');
  const [patName, setPatName] = useState('');
  const [patSecret, setPatSecret] = useState('');
  const [useCA, setUseCA] = useState(false);
  const [caClientId, setCaClientId] = useState('');
  const [caSecretId, setCaSecretId] = useState('');
  const [caSecretValue, setCaSecretValue] = useState('');

  async function loadSummary(): Promise<void> {
    try {
      const { credentialSummary } = await api.getCredentials();
      setSummary(credentialSummary);
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    void loadSummary();
  }, []);

  function beginEdit(): void {
    setError(null);
    // Prefill non-secret fields; secrets always start empty and must be re-entered.
    setPin('');
    setCloudUrl(summary?.cloudUrl ?? '');
    setSiteContentUrl(summary?.siteContentUrl ?? '');
    setPatName(summary?.patName ?? '');
    setPatSecret('');
    setUseCA(Boolean(summary?.hasConnectedApp));
    setCaClientId(summary?.connectedAppClientId ?? '');
    setCaSecretId('');
    setCaSecretValue('');
    setEditing(true);
  }

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { credentialSummary } = await api.updateCredentials({
        pin,
        cloudUrl,
        siteContentUrl,
        patName,
        patSecret,
        connectedApp: useCA ? { clientId: caClientId, secretId: caSecretId, secretValue: caSecretValue } : undefined,
      });
      setSummary(credentialSummary);
      setEditing(false);
      // Credentials changed → connection/flow were reset server-side. Refresh context.
      onChange(await api.session());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Tableau credentials</h2>
        {!editing ? (
          <button className="ghost" onClick={beginEdit} disabled={ctx.hasPlan}>
            Edit…
          </button>
        ) : null}
      </div>

      {!editing ? (
        <div className="col" style={{ gap: 4 }}>
          {summary ? (
            <>
              <SummaryRow label="Cloud URL" value={summary.cloudUrl} />
              <SummaryRow label="Site" value={summary.siteContentUrl || '(default)'} />
              <SummaryRow label="PAT name" value={summary.patName} />
              <SummaryRow label="PAT secret" value={summary.hasPatSecret ? '•••••••• (stored)' : 'not set'} />
              <SummaryRow
                label="Connected App"
                value={summary.hasConnectedApp ? `configured (${summary.connectedAppClientId ?? 'client id set'})` : 'none'}
              />
              {ctx.hasPlan ? (
                <p className="small muted">Finish or clear the current plan before editing credentials.</p>
              ) : null}
            </>
          ) : (
            <p className="small muted">No credentials on file.</p>
          )}
        </div>
      ) : (
        <form className="col" onSubmit={save}>
          <p className="hint">
            Re-enter your 6-digit PIN to authorize the change. For security, secrets are not shown and must be re-entered.
          </p>
          <div>
            <label>6-digit PIN</label>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="••••••"
              autoComplete="off"
              required
            />
          </div>
          <div>
            <label>Tableau Cloud URL</label>
            <input placeholder="https://10ax.online.tableau.com" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} required />
          </div>
          <div>
            <label>Site content URL (site slug)</label>
            <input placeholder="your-site" value={siteContentUrl} onChange={(e) => setSiteContentUrl(e.target.value)} />
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Personal Access Token name</label>
              <input value={patName} onChange={(e) => setPatName(e.target.value)} required />
            </div>
            <div style={{ flex: 1 }}>
              <label>Personal Access Token secret</label>
              <input type="password" value={patSecret} onChange={(e) => setPatSecret(e.target.value)} autoComplete="off" required />
            </div>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={useCA} onChange={(e) => setUseCA(e.target.checked)} />
            <span>Connected App for seamless embedded Web Authoring (optional)</span>
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
                  <input type="password" value={caSecretId} onChange={(e) => setCaSecretId(e.target.value)} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <label>Secret Value</label>
                  <input type="password" value={caSecretValue} onChange={(e) => setCaSecretValue(e.target.value)} autoComplete="off" />
                </div>
              </div>
            </div>
          ) : null}
          <ErrorPanel error={error} onDismiss={() => setError(null)} />
          <div className="row">
            <button type="submit" disabled={busy || pin.length !== 6}>
              {busy ? <Busy label="Saving…" /> : 'Save changes'}
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!editing ? <ErrorPanel error={error} onDismiss={() => setError(null)} /> : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
      <span className="small muted">{label}</span>
      <span className="small" style={{ textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  );
}
