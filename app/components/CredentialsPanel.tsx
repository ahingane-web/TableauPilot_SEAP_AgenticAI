import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { CredentialSummary, SessionContext } from '../types';
import { Busy, Collapsible, ErrorPanel } from './common';

type SectionKey = 'tableau' | 'salesforce' | 'bigquery' | 'datacloud' | 'snowflake';
type SectionMode = 'view' | 'edit' | 'delete';

/**
 * Left-top Vault: Tableau PAT save/edit/delete plus compact connector summaries.
 * Connector logins are saved from the Connect forms (Save Creds in Vault). Secrets
 * never come back to the browser.
 */
export function CredentialsPanel({
  ctx,
  onChange,
  vaultNonce = 0,
  onVaultChange,
  expanded,
  onToggle,
}: {
  ctx: SessionContext;
  onChange: (ctx: SessionContext) => void;
  vaultNonce?: number;
  onVaultChange?: () => void;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const [summary, setSummary] = useState<CredentialSummary | null>(null);
  const [active, setActive] = useState<{ key: SectionKey; mode: SectionMode } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
  }, [ctx.hasCredentials, vaultNonce]);

  function resetSecrets(): void {
    setPin('');
    setPatSecret('');
    setCaSecretId('');
    setCaSecretValue('');
  }

  function cancel(): void {
    setError(null);
    resetSecrets();
    setActive(null);
  }

  function beginTableau(mode: SectionMode): void {
    setError(null);
    resetSecrets();
    if (mode === 'edit') {
      setCloudUrl(summary?.cloudUrl ?? '');
      setSiteContentUrl(summary?.siteContentUrl ?? '');
      setPatName(summary?.patName ?? '');
      setUseCA(Boolean(summary?.hasConnectedApp));
      setCaClientId(summary?.connectedAppClientId ?? '');
    }
    setActive({ key: 'tableau', mode });
  }

  async function afterSave(summaryNext: CredentialSummary): Promise<void> {
    setSummary(summaryNext);
    setActive(null);
    resetSecrets();
    onChange(await api.session());
    onVaultChange?.();
  }

  async function saveTableau(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = {
        cloudUrl,
        siteContentUrl,
        patName,
        patSecret,
        connectedApp: useCA ? { clientId: caClientId, secretId: caSecretId, secretValue: caSecretValue } : undefined,
      };
      const { credentialSummary } =
        ctx.hasCredentials && active?.mode === 'edit'
          ? await api.updateCredentials({ pin, ...body })
          : await api.saveCredentials(body);
      await afterSave(credentialSummary);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTableau(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const next = await api.deleteCredentials({ pin });
      setSummary(null);
      setActive(null);
      resetSecrets();
      setCloudUrl('');
      setSiteContentUrl('');
      setPatName('');
      setUseCA(false);
      setCaClientId('');
      onChange(next);
      onVaultChange?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function deleteConnector(
    e: React.FormEvent,
    deleter: (body: { pin: string }) => Promise<{ credentialSummary: CredentialSummary }>,
  ): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { credentialSummary } = await deleter({ pin });
      await afterSave(credentialSummary);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const tableauForm = (
    <>
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
    </>
  );

  const pinField = (
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
  );

  const locked = ctx.hasPlan;

  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0 }}>Vault</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            Signed in as <strong>{ctx.username}</strong>
            {ctx.hasCredentials ? ' · Tableau credentials saved' : ' · save Tableau credentials to continue'}
          </p>
        </div>
        <button type="button" className="ghost" onClick={onToggle} style={{ flexShrink: 0 }}>
          {expanded ? 'Hide Vault' : 'Show Vault'}
        </button>
      </div>
      {expanded ? (
        <div style={{ marginTop: 10 }}>
          <ErrorPanel error={error} onDismiss={() => setError(null)} />

      <Collapsible title="Tableau" badge={ctx.hasCredentials ? 'saved' : 'required'} defaultOpen>
        {!ctx.hasCredentials || (active?.key === 'tableau' && active.mode === 'edit') ? (
          <form className="col" onSubmit={saveTableau}>
            <p className="hint">
              {ctx.hasCredentials
                ? 'Re-enter your PIN and secrets to replace the saved Tableau connection.'
                : 'Encrypted with your PIN and stored server-side. Never sent back to the browser.'}
            </p>
            {ctx.hasCredentials ? pinField : null}
            {tableauForm}
            <div className="row">
              <button type="submit" disabled={busy || (ctx.hasCredentials && pin.length !== 6)}>
                {busy ? <Busy label="Saving…" /> : ctx.hasCredentials ? 'Save changes' : 'Save credentials'}
              </button>
              {ctx.hasCredentials ? (
                <button type="button" className="ghost" onClick={cancel} disabled={busy}>
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        ) : active?.key === 'tableau' && active.mode === 'delete' ? (
          <form className="col" onSubmit={deleteTableau}>
            <p className="hint">Removes Tableau PAT, Connected App, and every saved connector login. Vault username and PIN stay.</p>
            {pinField}
            <div className="row">
              <button type="submit" className="danger" disabled={busy || pin.length !== 6}>
                {busy ? <Busy label="Deleting…" /> : 'Delete Tableau credentials'}
              </button>
              <button type="button" className="ghost" onClick={cancel} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <SectionView
            rows={[
              ['Cloud URL', summary?.cloudUrl ?? ''],
              ['Site', summary?.siteContentUrl || '(default)'],
              ['PAT name', summary?.patName ?? ''],
              ['PAT secret', summary?.hasPatSecret ? '•••••••• (stored)' : 'not set'],
              [
                'Connected App',
                summary?.hasConnectedApp ? `configured (${summary.connectedAppClientId ?? 'client id set'})` : 'none',
              ],
            ]}
            locked={locked}
            onEdit={() => beginTableau('edit')}
            onDelete={() => beginTableau('delete')}
          />
        )}
      </Collapsible>

      <ConnectorSummary
        title="Salesforce"
        saved={Boolean(summary?.hasSalesforce)}
        rows={
          summary?.hasSalesforce
            ? [
                ['Login URL', summary.salesforceUrl ?? ''],
                ['Username', summary.salesforceUsername ?? ''],
                ['Password', summary.salesforceHasPassword ? '•••••••• (stored)' : 'not set'],
              ]
            : []
        }
        locked={locked}
        deleting={active?.key === 'salesforce' && active.mode === 'delete'}
        pin={pin}
        setPin={setPin}
        busy={busy}
        onDelete={() => {
          setError(null);
          resetSecrets();
          setActive({ key: 'salesforce', mode: 'delete' });
        }}
        onCancel={cancel}
        onSubmit={(e) => deleteConnector(e, api.deleteSalesforceAccount)}
        hint="Save from Build datasource → Salesforce (Save Creds in Vault)."
      />
      <ConnectorSummary
        title="Google BigQuery"
        saved={Boolean(summary?.hasBigQueryOAuth)}
        rows={
          summary?.hasBigQueryOAuth
            ? [
                ['Client ID', summary.bigQueryOAuthClientId ?? ''],
                ['Client secret', summary.bigQueryOAuthHasSecret ? '•••••••• (stored)' : 'none'],
              ]
            : []
        }
        locked={locked}
        deleting={active?.key === 'bigquery' && active.mode === 'delete'}
        pin={pin}
        setPin={setPin}
        busy={busy}
        onDelete={() => {
          setError(null);
          resetSecrets();
          setActive({ key: 'bigquery', mode: 'delete' });
        }}
        onCancel={cancel}
        onSubmit={(e) => deleteConnector(e, api.deleteBigQueryAccount)}
        hint="Save the OAuth client from Build datasource → BigQuery (not the Google access token)."
      />
      <ConnectorSummary
        title="Salesforce Data Cloud"
        saved={Boolean(summary?.hasDataCloud)}
        rows={
          summary?.hasDataCloud
            ? [
                ['My Domain', summary.dataCloudUrl ?? ''],
                ['Connected App', summary.dataCloudClientId ?? 'none'],
                ['Client secret', summary.dataCloudHasClientSecret ? '•••••••• (stored)' : 'none'],
                ['SOAP user', summary.dataCloudUsername ?? 'none'],
              ]
            : []
        }
        locked={locked}
        deleting={active?.key === 'datacloud' && active.mode === 'delete'}
        pin={pin}
        setPin={setPin}
        busy={busy}
        onDelete={() => {
          setError(null);
          resetSecrets();
          setActive({ key: 'datacloud', mode: 'delete' });
        }}
        onCancel={cancel}
        onSubmit={(e) => deleteConnector(e, api.deleteDataCloudAccount)}
        hint="Save from Build datasource → Data Cloud (Save Creds in Vault)."
      />
      <ConnectorSummary
        title="Snowflake"
        saved={Boolean(summary?.hasSnowflake)}
        rows={
          summary?.hasSnowflake
            ? [
                ['Server', summary.snowflakeUrl ?? ''],
                ['Warehouse', summary.snowflakeWarehouse ?? ''],
                ['Username', summary.snowflakeUsername ?? ''],
                ['Password', summary.snowflakeHasPassword ? '•••••••• (stored)' : 'not set'],
              ]
            : []
        }
        locked={locked}
        deleting={active?.key === 'snowflake' && active.mode === 'delete'}
        pin={pin}
        setPin={setPin}
        busy={busy}
        onDelete={() => {
          setError(null);
          resetSecrets();
          setActive({ key: 'snowflake', mode: 'delete' });
        }}
        onCancel={cancel}
        onSubmit={(e) => deleteConnector(e, api.deleteSnowflakeAccount)}
        hint="Save from Build datasource → Snowflake (Save Creds in Vault)."
      />
        </div>
      ) : null}
    </div>
  );
}

function ConnectorSummary({
  title,
  saved,
  rows,
  locked,
  deleting,
  pin,
  setPin,
  busy,
  onDelete,
  onCancel,
  onSubmit,
  hint,
}: {
  title: string;
  saved: boolean;
  rows: Array<[string, string]>;
  locked: boolean;
  deleting: boolean;
  pin: string;
  setPin: (v: string) => void;
  busy: boolean;
  onDelete: () => void;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
  hint: string;
}): React.ReactElement {
  return (
    <Collapsible title={title} badge={saved ? 'saved' : 'not saved'} defaultOpen={false}>
      {deleting ? (
        <form className="col" onSubmit={onSubmit}>
          <p className="hint">Re-enter your PIN to remove this saved login. Tableau credentials stay.</p>
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
          <div className="row">
            <button type="submit" className="danger" disabled={busy || pin.length !== 6}>
              {busy ? <Busy label="Deleting…" /> : `Delete ${title} credentials`}
            </button>
            <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : saved ? (
        <div className="col" style={{ gap: 4 }}>
          {rows.map(([label, value]) => (
            <div key={label} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
              <span className="small muted">{label}</span>
              <span className="small" style={{ textAlign: 'right', wordBreak: 'break-all' }}>
                {value}
              </span>
            </div>
          ))}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="ghost" onClick={onDelete} disabled={locked}>
              Delete
            </button>
          </div>
          {locked ? <p className="small muted">Finish or clear the current plan before deleting credentials.</p> : null}
        </div>
      ) : (
        <p className="hint">{hint}</p>
      )}
    </Collapsible>
  );
}

function SectionView({
  rows,
  locked,
  onEdit,
  onDelete,
}: {
  rows: Array<[string, string]>;
  locked: boolean;
  onEdit: () => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <div className="col" style={{ gap: 4 }}>
      {rows.map(([label, value]) => (
        <div key={label} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
          <span className="small muted">{label}</span>
          <span className="small" style={{ textAlign: 'right', wordBreak: 'break-all' }}>
            {value}
          </span>
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="ghost" onClick={onEdit} disabled={locked}>
          Edit
        </button>
        <button className="ghost" onClick={onDelete} disabled={locked}>
          Delete
        </button>
      </div>
      {locked ? <p className="small muted">Finish or clear the current plan before editing or deleting credentials.</p> : null}
    </div>
  );
}
