import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CredentialSummary, NamedItem } from '../types';
import { Busy } from './common';
import { DataModelBuilder, type DataModel } from './DataModelBuilder';

type ObjectCategory = 'dmo' | 'dlo' | 'ci' | 'all';

const CATEGORY_OPTIONS: Array<{ value: ObjectCategory; label: string }> = [
  { value: 'dmo', label: 'Data Model Objects' },
  { value: 'dlo', label: 'Data Lake Objects' },
  { value: 'ci', label: 'Calculated Insights' },
  { value: 'all', label: 'All Objects' },
];

/**
 * The "Build datasource" sub-flow for the Salesforce Data Cloud (Genie) connector.
 *
 * Sign-in prefers browser OAuth with CDP scopes (`api`, `cdp_query_api`) because SOAP
 * session ids fail `/services/a360/token` on many orgs (HTTP 500). Password SOAP login
 * remains as a fallback. After connect the user picks a
 * Data Space and object category; objects feed the shared DataModelBuilder. Live publishes
 * a bare `salesforce-genie` `.tds`; Extract materializes a local `.hyper`. On success the
 * parent locks the new datasource.
 */
export function DataCloudBuild({
  busy,
  setBusy,
  projects,
  onPublished,
  vaultSummary,
  onVaultSaved,
}: {
  busy: string | null;
  setBusy: (v: string | null) => void;
  projects: NamedItem[];
  onPublished: (res: {
    datasource: { name: string };
    extract?: { state?: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
  }) => Promise<void>;
  vaultSummary: CredentialSummary | null;
  onVaultSaved: () => Promise<void>;
}): React.ReactElement {
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [savingVault, setSavingVault] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<string | null>(null);

  const [dataSpaces, setDataSpaces] = useState<Array<{ name: string; label: string }>>([]);
  const [dataSpace, setDataSpace] = useState('');
  const [category, setCategory] = useState<ObjectCategory>('all');
  const [objects, setObjects] = useState<Array<{ name: string; label: string }>>([]);
  const [loadingScope, setLoadingScope] = useState<string | null>(null);

  const [model, setModel] = useState<DataModel>({ objects: [], relationships: [], mode: 'relationship', valid: false });
  const [materialization, setMaterialization] = useState<'live' | 'extract'>('extract');
  const [projectId, setProjectId] = useState('');
  const [dsName, setDsName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const popupRef = useRef<Window | null>(null);

  const vaultSaved = Boolean(vaultSummary?.hasDataCloud);
  const needsClient = oauthConfigured === false;
  const canSignIn =
    !connecting && (Boolean(url.trim()) || vaultSaved) && (!needsClient || Boolean(clientId.trim()) || vaultSaved);

  async function afterConnected(nextUsername?: string): Promise<void> {
    const spaces = await api.dataCloudDataSpaces();
    setDataSpaces(spaces.dataSpaces);
    if (nextUsername) setUsername(nextUsername);
    setConnected(true);
    setDataSpace('');
    setObjects([]);
    setModel({ objects: [], relationships: [], mode: 'relationship', valid: false });
  }

  useEffect(() => {
    let cancelled = false;
    api
      .connectors()
      .then((r) => {
        const dc = r.items.find((it) => it.id === 'datacloud');
        if (cancelled) return;
        setOauthConfigured(Boolean(dc?.oauthConfigured));
        setRedirectUri(dc?.oauthRedirectUri ?? '');
      })
      .catch(() => {
        if (!cancelled) setOauthConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      const data = e.data as { type?: string; ok?: boolean; message?: string; username?: string } | undefined;
      if (!data || data.type !== 'dc-oauth') return;
      if (data.ok) {
        void afterConnected(data.username).catch((err) => {
          setConnectError(err instanceof Error ? err.message : 'Could not list Data Cloud data spaces.');
          setConnected(false);
        }).finally(() => setConnecting(false));
      } else {
        setConnecting(false);
        setConnectError(data.message || 'Data Cloud sign-in failed.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function signIn(): Promise<void> {
    if (!canSignIn) return;
    setConnecting(true);
    setConnectError(null);
    setVaultNotice(null);
    try {
      const { authUrl } = await api.dataCloudOauthStart(
        url.trim() || clientId.trim()
          ? { url: url.trim() || undefined, clientId: clientId.trim() || undefined, clientSecret: clientSecret.trim() || undefined }
          : {},
      );
      const w = window.open(authUrl, 'dc-oauth', 'width=900,height=800,scrollbars=yes');
      popupRef.current = w;
      if (!w) {
        setConnecting(false);
        setConnectError('Could not open the Salesforce sign-in window. Allow pop-ups for this site and try again.');
      }
    } catch (e) {
      setConnecting(false);
      setConnectError(e instanceof Error ? e.message : 'Could not start Data Cloud sign-in.');
    }
  }

  async function saveCredsInVault(): Promise<void> {
    if (!url.trim() || (!clientId.trim() && !username.trim())) {
      setConnectError('Enter your My Domain URL and a Connected App consumer key (or SOAP username) to save.');
      return;
    }
    setSavingVault(true);
    setConnectError(null);
    try {
      await api.saveDataCloudAccount({
        url: url.trim(),
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined,
        username: username.trim() || undefined,
        password: password || undefined,
        token: token || undefined,
      });
      await onVaultSaved();
      setVaultNotice('Saved in Vault.');
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not save Data Cloud credentials.');
    } finally {
      setSavingVault(false);
    }
  }

  async function useSavedCreds(): Promise<void> {
    if (!vaultSaved) return;
    setUrl(vaultSummary?.dataCloudUrl ?? '');
    setClientId(vaultSummary?.dataCloudClientId ?? '');
    setUsername(vaultSummary?.dataCloudUsername ?? '');
    setClientSecret('');
    setPassword('');
    setToken('');
    setConnecting(true);
    setConnectError(null);
    setVaultNotice(null);
    try {
      const { authUrl } = await api.dataCloudOauthStart({});
      const w = window.open(authUrl, 'dc-oauth', 'width=900,height=800,scrollbars=yes');
      popupRef.current = w;
      if (!w) {
        setConnecting(false);
        setConnectError('Could not open the Salesforce sign-in window. Allow pop-ups for this site and try again.');
      }
    } catch (e) {
      setConnecting(false);
      setConnectError(e instanceof Error ? e.message : 'Could not start Data Cloud sign-in.');
    }
  }

  async function connectPassword(): Promise<void> {
    if (!url || !username || !password) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await api.dataCloudConnect({ url, username, password, token: token || undefined });
      await afterConnected();
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not connect to Salesforce Data Cloud.');
      setConnected(false);
      setDataSpaces([]);
      setObjects([]);
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    if (!connected || !dataSpace) {
      setObjects([]);
      return;
    }
    let cancelled = false;
    setLoadingScope('objects');
    api
      .dataCloudObjects(dataSpace, category)
      .then((res) => {
        if (cancelled) return;
        setObjects(res.objects.map((o) => ({ name: o.name, label: o.label })));
        setConnectError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setConnectError(e instanceof Error ? e.message : 'Could not list Data Cloud objects.');
        setObjects([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, dataSpace, category]);

  const scopeReady = connected && Boolean(dataSpace) && objects.length > 0;
  const ready = Boolean(model.valid && projectId && dsName && dataSpace && (username || vaultSaved));

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy('datacloud-publish');
    setPublishError(null);
    try {
      const res = await api.dataCloudPublish({
        credentials: password
          ? { url, username, password, token: token || undefined }
          : { url: url || undefined, username: username || undefined },
        dataSpace,
        category,
        tables: model.objects,
        relationships: model.relationships,
        mode: model.mode,
        materialization,
        projectId,
        datasourceName: dsName,
        overwrite,
      });
      await onPublished(res);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : 'Could not publish the Data Cloud datasource.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sf">
      <div className="sf-head">
        <div className="sf-logo">DC</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">Salesforce Data Cloud</div>
          <div className="s">Sign in with Salesforce, pick a data space and objects, then publish a live or extract datasource.</div>
        </div>
      </div>

      <div className="sf-steps">
        <div className={`st ${connected ? 'done' : 'active'}`}>
          <span className="n">{connected ? '✓' : '1'}</span> Sign in
        </div>
        <span className="sep" />
        <div className={`st ${scopeReady ? 'done' : connected ? 'active' : ''}`}>
          <span className="n">{scopeReady ? '✓' : '2'}</span> Scope
        </div>
        <span className="sep" />
        <div className={`st ${model.valid ? 'done' : scopeReady ? 'active' : ''}`}>
          <span className="n">{model.valid ? '✓' : '3'}</span> Model
        </div>
        <span className="sep" />
        <div className={`st ${ready ? 'active' : ''}`}>
          <span className="n">4</span> Publish
        </div>
      </div>

      <div className="sf-section">
        <div className="h">
          <span className="dot" />
          <span className="tt">Connect to Salesforce Data Cloud</span>
          {connected ? (
            <span className="badge ok small" style={{ marginLeft: 'auto' }}>
              Connected{username ? ` · ${username}` : ''}
            </span>
          ) : null}
        </div>
        <div className="sf-note" style={{ marginBottom: 10 }}>
          A Salesforce sign-in window opens so you can authorize Data Cloud access. The token is held{' '}
          <strong>only on the server</strong> for this session. Published datasources use your{' '}
          <strong>saved Salesforce Data Cloud credential</strong> on Tableau Cloud.
        </div>
        <div className="sf-grid" style={{ marginBottom: 10 }}>
            <div className="full" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="secondary small"
              onClick={() => setShowHelp((v) => !v)}
              aria-expanded={showHelp}
            >
              {showHelp ? '▾' : '▸'} How do I connect Salesforce Data Cloud?
            </button>
          </div>
          {showHelp ? (
            <div className="full sf-note" style={{ lineHeight: 1.5 }}>
              <ol style={{ margin: '4px 0 4px 18px', padding: 0 }}>
                <li>
                  In Salesforce, open <strong>Setup → My Domain</strong> and copy the login URL (
                  <code>https://yourorg.my.salesforce.com</code>). Paste it in the field below. Do{' '}
                  <strong>not</strong> use <code>login.salesforce.com</code> — that often fails with{' '}
                  <code>OAUTH_APPROVAL_ERROR_GENERIC</code>.
                </li>
                <li>
                  Stay logged into that My Domain in a <strong>normal browser tab</strong>, then click Sign in here so
                  the popup only has to approve the app (a blank popup usually means you were not logged in).
                </li>
                <li>
                  <strong>Setup → App Manager → New Connected App</strong> (or External Client App). Enable OAuth
                  Settings.
                </li>
                <li>
                  Under <strong>Callback URL</strong>, add exactly:{' '}
                  <code>{redirectUri || 'http://localhost:4000/api/connectors/salesforce/oauth/callback'}</code>
                </li>
                <li>
                  Selected OAuth Scopes must include <strong>Manage user data via APIs (api)</strong> and{' '}
                  <strong>Perform ANSI SQL queries on Data Cloud data (cdp_query_api)</strong>. Extra scopes are
                  optional; requesting ones the app does not list causes a generic OAuth error.
                </li>
                <li>
                  OAuth policies: <strong>All users may self-authorize</strong>. Relax IP restrictions for local
                  testing. Save, then copy the <strong>Consumer Key</strong> and <strong>Consumer Secret</strong> into
                  the fields below.
                </li>
                <li>
                  If Salesforce still says <code>OAUTH_APPROVAL_ERROR_GENERIC</code>, assign{' '}
                  <strong>Approve Uninstalled Connected Apps</strong> to your user, then try once more. After a
                  successful login, <strong>Setup → Connected Apps OAuth Usage</strong> → <strong>Install</strong> the
                  app if it appears.
                </li>
              </ol>
            </div>
          ) : null}
          <div className="full">
            <label title="Paste Setup → My Domain (https://yourorg.my.salesforce.com). Do not use login.salesforce.com.">
              Salesforce My Domain URL
            </label>
            <input
              placeholder="https://yourorg.my.salesforce.com"
              title="Paste Setup → My Domain (https://yourorg.my.salesforce.com). Do not use login.salesforce.com."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={connected}
            />
          </div>
          {needsClient ? (
            <>
              <div className="full">
                <label>Connected App Consumer Key</label>
                <input
                  placeholder="Consumer Key"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={connected}
                />
              </div>
              <div className="full">
                <label>Consumer Secret</label>
                <input
                  type="password"
                  placeholder="Consumer Secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  disabled={connected}
                />
              </div>
            </>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button className={connected ? 'secondary' : ''} onClick={signIn} disabled={!canSignIn || savingVault}>
            {connecting && !showPassword ? (
              <Busy label="Waiting for Salesforce…" />
            ) : connected ? (
              'Reconnect with Salesforce'
            ) : (
              'Sign in with Salesforce'
            )}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={saveCredsInVault}
            disabled={!url.trim() || (!clientId.trim() && !username.trim()) || connecting || savingVault}
          >
            {savingVault ? <Busy label="Saving…" /> : 'Save Creds in Vault'}
          </button>
          <button type="button" className="ghost" onClick={useSavedCreds} disabled={!vaultSaved || connecting || savingVault}>
            Use Saved Creds
          </button>
          {!connected && !connectError ? (
            <span className="small muted">
              {!url.trim() && !vaultSaved
                ? 'Enter your Salesforce My Domain URL to enable sign-in.'
                : needsClient && !clientId.trim() && !vaultSaved
                  ? 'Paste your Connected App Consumer Key (and Secret) to enable sign-in.'
                  : 'Opens a popup to authorize Data Cloud access.'}
            </span>
          ) : null}
        </div>
        {vaultNotice ? <p className="small muted" style={{ marginTop: 8 }}>{vaultNotice}</p> : null}
        <button
          type="button"
          className="secondary small"
          style={{ marginTop: 10 }}
          onClick={() => setShowPassword((v) => !v)}
        >
          {showPassword ? '▾' : '▸'} Password login (SOAP) — often fails Data Cloud token exchange
        </button>
        {showPassword ? (
          <div className="sf-grid" style={{ marginTop: 10 }}>
            <div className="full">
              <label>Username</label>
              <input
                placeholder="jane.doe@example.com"
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div>
              <label>Password</label>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div>
              <label>
                Security token <span className="muted">(optional)</span>
              </label>
              <input
                type="password"
                autoComplete="new-password"
                placeholder="If your org requires it"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="full row">
              <button
                className="secondary"
                onClick={connectPassword}
                disabled={(!url || !username || !password) || connecting}
              >
                {connecting ? <Busy label="Connecting…" /> : 'Connect with password'}
              </button>
            </div>
          </div>
        ) : null}
        {connectError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {connectError}
          </div>
        ) : null}
      </div>

      <div className={`sf-section ${connected ? '' : 'disabled'}`}>
        <div className="h">
          <span className="dot" />
          <span className="tt">Data space · Object type</span>
          {loadingScope ? (
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              <Busy label={`Loading ${loadingScope}…`} />
            </span>
          ) : null}
        </div>
        <div className="sf-grid">
          <div>
            <label>Data space</label>
            <select value={dataSpace} onChange={(e) => setDataSpace(e.target.value)} disabled={!connected}>
              <option value="">Select a data space…</option>
              {dataSpaces.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label === s.name ? s.name : `${s.label} (${s.name})`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Object type</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ObjectCategory)}
              disabled={!dataSpace}
            >
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {scopeReady ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            {objects.length} object{objects.length === 1 ? '' : 's'} in {dataSpace}
          </div>
        ) : connected && dataSpace && !loadingScope ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            No objects of this type in {dataSpace}. Try another object type or data space.
          </div>
        ) : null}
      </div>

      <DataModelBuilder
        key={`${dataSpace}/${category}`}
        objects={objects}
        describe={(name) => api.dataCloudDescribe(dataSpace, name).then((r) => r.fields)}
        onChange={setModel}
        disabled={!scopeReady}
        noun="object"
        nounPlural="objects"
      />

      <div className={`sf-section ${scopeReady ? '' : 'disabled'}`}>
        <div className="h">
          <span className="dot" />
          <span className="tt">Publish to Tableau Cloud</span>
        </div>

        <div>
          <label>Connection type</label>
          <div className="row" style={{ gap: 16, marginTop: 4 }}>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="dc-materialization"
                checked={materialization === 'extract'}
                onChange={() => setMaterialization('extract')}
              />
              Extract (bundled <code>.hyper</code>, refreshed after publish)
            </label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="dc-materialization"
                checked={materialization === 'live'}
                onChange={() => setMaterialization('live')}
              />
              Live (Tableau queries Data Cloud directly)
            </label>
          </div>
          <div className="sf-note" style={{ marginTop: 8 }}>
            {materialization === 'extract'
              ? 'Rows are queried now and materialized into an extract. After publishing, a server-side extract refresh runs on Tableau Cloud.'
              : 'No data is copied — Tableau Cloud connects to Data Cloud live over OAuth using your embedded saved credential.'}
          </div>
        </div>

        <div className="sf-grid" style={{ marginTop: 12 }}>
          <div className="full">
            <label>Project / folder</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="full">
            <label>Datasource name</label>
            <input placeholder="e.g. Data Cloud Account DS" value={dsName} onChange={(e) => setDsName(e.target.value)} />
          </div>
        </div>
        <label className="checkline" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite if a datasource with this name already exists</span>
        </label>
        {publishError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {publishError}
          </div>
        ) : null}
        <button style={{ marginTop: 14, width: '100%' }} onClick={submit} disabled={!ready || busy === 'datacloud-publish'}>
          {busy === 'datacloud-publish' ? <Busy label="Publishing…" /> : 'Create & publish datasource'}
        </button>
      </div>
    </div>
  );
}
