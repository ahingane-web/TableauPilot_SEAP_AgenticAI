import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { CredentialSummary, NamedItem } from '../types';
import { Busy } from './common';
import { DataModelBuilder, type DataModel } from './DataModelBuilder';

/** A GCP project (used for both the billing-project and data-project pickers). */
interface BqProject {
  id: string;
  name: string;
}

/**
 * The "Build datasource" sub-flow for the Google BigQuery connector.
 *
 * The user signs in with Google in a popup (OAuth); the server holds the access/refresh
 * token transiently. The user then picks a Billing Project > Project > Dataset, and the
 * dataset's tables feed into the SAME {@link DataModelBuilder} the Salesforce/Excel flows
 * use (tables play the role of objects). A Live/Extract selector chooses how the datasource
 * is published: LIVE queries BigQuery directly over OAuth; EXTRACT materializes the rows into
 * a bundled `.hyper` and refreshes it on Tableau Cloud after publishing. On success the parent
 * locks the new datasource and the dashboard flow proceeds unchanged. No Salesforce/Excel
 * logic is involved.
 */
export function BigQueryBuild({
  busy,
  setBusy,
  projects,
  onPublished,
  vaultSummary,
  onVaultSaved,
}: {
  busy: string | null;
  setBusy: (v: string | null) => void;
  /** Tableau projects/folders to publish INTO. */
  projects: NamedItem[];
  onPublished: (res: {
    datasource: { name: string };
    extract?: { state?: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
  }) => Promise<void>;
  vaultSummary: CredentialSummary | null;
  onVaultSaved: () => Promise<void>;
}): React.ReactElement {
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const connected = Boolean(email);

  // Whether the SERVER already holds a Google OAuth client (via GOOGLE_OAUTH_*). When it does
  // NOT (`false`), the user supplies their own Client ID (+ optional secret) here so the
  // credential stays dynamic and is never stored in `.env`. `null` = still loading.
  const [oauthConfigured, setOauthConfigured] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  // Vault persistence of the OAuth client (so the user doesn't re-enter it every session).
  const [savedInVault, setSavedInVault] = useState(false);
  const [secretSaved, setSecretSaved] = useState(false);
  const [savingVault, setSavingVault] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [bqProjects, setBqProjects] = useState<BqProject[]>([]);
  const [billingProjectId, setBillingProjectId] = useState('');
  const [dataProjectId, setDataProjectId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [datasets, setDatasets] = useState<Array<{ id: string; location?: string }>>([]);
  const [tables, setTables] = useState<Array<{ id: string; type?: string }>>([]);
  const [loadingScope, setLoadingScope] = useState<string | null>(null);

  const [model, setModel] = useState<DataModel>({ objects: [], relationships: [], mode: 'relationship', valid: false });
  const [materialization, setMaterialization] = useState<'live' | 'extract'>('extract');
  const [projectId, setProjectId] = useState('');
  const [dsName, setDsName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const popupRef = useRef<Window | null>(null);

  // Load the account's GCP projects once the session is connected.
  async function loadProjects(): Promise<void> {
    try {
      const res = await api.bigQueryProjects();
      setBqProjects(res.projects);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not list Google Cloud projects.');
    }
  }

  // After the OAuth popup posts back, confirm the server has a live BigQuery session.
  async function confirmConnected(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const s = await api.bigQueryStatus();
        if (s.connected) {
          setEmail(s.email ?? '');
          setConnecting(false);
          await loadProjects();
          return;
        }
      } catch {
        /* transient — retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    setConnecting(false);
  }

  // Discover whether the server already has a Google OAuth client configured. If not, the
  // sign-in step asks the user for a Client ID (+ optional secret) instead of reading `.env`.
  useEffect(() => {
    let cancelled = false;
    api
      .connectors()
      .then((r) => {
        const bq = r.items.find((it) => it.id === 'bigquery');
        if (cancelled) return;
        setOauthConfigured(Boolean(bq?.oauthConfigured));
        setRedirectUri(bq?.oauthRedirectUri ?? '');
      })
      .catch(() => {
        if (!cancelled) setOauthConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Prefill the OAuth client id from the user's vault (if they saved it previously) so they
  // can just click "Sign in with Google" on later visits. The secret is never sent back — we
  // only learn whether one is stored; leaving the secret field blank reuses the saved one.
  useEffect(() => {
    let cancelled = false;
    api
      .bigQueryOAuthClientGet()
      .then((r) => {
        if (cancelled) return;
        if (r.clientId) {
          setClientId(r.clientId);
          setSavedInVault(true);
        }
        setSecretSaved(r.hasSecret);
      })
      .catch(() => {
        /* nothing saved yet — the user will enter it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for the OAuth popup's postMessage (type: 'bq-oauth').
  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      const data = e.data as { type?: string; ok?: boolean; message?: string } | undefined;
      if (!data || data.type !== 'bq-oauth') return;
      if (data.ok) {
        void confirmConnected();
      } else {
        setConnecting(false);
        setConnectError(data.message || 'Google sign-in failed.');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // When the server has no configured client, the user supplies a Client ID here.
  const vaultSaved = Boolean(vaultSummary?.hasBigQueryOAuth || savedInVault);
  const needsClient = oauthConfigured === false;
  const canSignIn = !connecting && (!needsClient || Boolean(clientId.trim()) || vaultSaved);

  async function signIn(): Promise<void> {
    if (!canSignIn) return;
    setConnecting(true);
    setConnectError(null);
    setVaultNotice(null);
    try {
      const { authUrl } = await api.bigQueryOauthStart(
        clientId.trim() || clientSecret.trim()
          ? { clientId: clientId.trim() || undefined, clientSecret: clientSecret.trim() || undefined }
          : {},
      );
      const w = window.open(authUrl, 'bq-oauth', 'width=520,height=680');
      popupRef.current = w;
      if (!w) {
        setConnecting(false);
        setConnectError('Could not open the Google sign-in window. Allow pop-ups for this site and try again.');
      }
    } catch (e) {
      setConnecting(false);
      setConnectError(e instanceof Error ? e.message : 'Could not start Google sign-in.');
    }
  }

  async function saveCredsInVault(): Promise<void> {
    if (!clientId.trim()) {
      setConnectError('Enter a Google OAuth Client ID to save.');
      return;
    }
    setSavingVault(true);
    setConnectError(null);
    try {
      await api.saveBigQueryAccount({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
      });
      setSavedInVault(true);
      if (clientSecret.trim()) setSecretSaved(true);
      await onVaultSaved();
      setVaultNotice('Saved in Vault.');
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not save BigQuery client.');
    } finally {
      setSavingVault(false);
    }
  }

  async function useSavedCreds(): Promise<void> {
    if (!vaultSaved) return;
    setClientId(vaultSummary?.bigQueryOAuthClientId ?? clientId);
    setClientSecret('');
    setConnecting(true);
    setConnectError(null);
    setVaultNotice(null);
    try {
      const { authUrl } = await api.bigQueryOauthStart({});
      const w = window.open(authUrl, 'bq-oauth', 'width=520,height=680');
      popupRef.current = w;
      if (!w) {
        setConnecting(false);
        setConnectError('Could not open the Google sign-in window. Allow pop-ups for this site and try again.');
      }
    } catch (e) {
      setConnecting(false);
      setConnectError(e instanceof Error ? e.message : 'Could not start Google sign-in.');
    }
  }

  // Load datasets when the data project changes.
  useEffect(() => {
    setDatasetId('');
    setDatasets([]);
    setTables([]);
    if (!dataProjectId) return;
    let cancelled = false;
    setLoadingScope('datasets');
    api
      .bigQueryDatasets(dataProjectId)
      .then((r) => {
        if (!cancelled) setDatasets(r.datasets);
      })
      .catch((e) => {
        if (!cancelled) setConnectError(e instanceof Error ? e.message : 'Could not list datasets.');
      })
      .finally(() => {
        if (!cancelled) setLoadingScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProjectId]);

  // Load tables when the dataset changes.
  useEffect(() => {
    setTables([]);
    if (!dataProjectId || !datasetId) return;
    let cancelled = false;
    setLoadingScope('tables');
    api
      .bigQueryTables(dataProjectId, datasetId)
      .then((r) => {
        if (!cancelled) setTables(r.tables);
      })
      .catch((e) => {
        if (!cancelled) setConnectError(e instanceof Error ? e.message : 'Could not list tables.');
      })
      .finally(() => {
        if (!cancelled) setLoadingScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProjectId, datasetId]);

  const modelObjects = useMemo(() => tables.map((t) => ({ name: t.id, label: t.id })), [tables]);
  const dataProjectName = useMemo(
    () => bqProjects.find((p) => p.id === dataProjectId)?.name ?? dataProjectId,
    [bqProjects, dataProjectId],
  );

  const scopeReady = Boolean(billingProjectId && dataProjectId && datasetId);
  const ready = Boolean(model.valid && scopeReady && projectId && dsName);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy('bigquery-publish');
    setPublishError(null);
    try {
      const res = await api.bigQueryPublish({
        billingProjectId,
        dataProjectId,
        dataProjectName,
        datasetId,
        tables: model.objects,
        relationships: model.relationships.map((r) => ({
          leftTable: r.leftObject,
          leftField: r.leftField,
          rightTable: r.rightObject,
          rightField: r.rightField,
          cardinality: r.cardinality,
          joinType: r.joinType,
        })),
        mode: model.mode,
        materialization,
        projectId,
        datasourceName: dsName,
        overwrite,
      });
      await onPublished(res);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : 'Could not publish the datasource.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sf">
      <div className="sf-head">
        <div className="sf-logo">BQ</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">Google BigQuery data source</div>
          <div className="s">Sign in with Google, pick a project & dataset, model your tables, then publish (live or extract).</div>
        </div>
      </div>

      <div className="sf-steps">
        <div className={`st ${connected ? 'done' : 'active'}`}>
          <span className="n">{connected ? '✓' : '1'}</span> Sign in
        </div>
        <span className="sep" />
        <div className={`st ${scopeReady ? 'done' : connected ? 'active' : ''}`}>
          <span className="n">{scopeReady ? '✓' : '2'}</span> Dataset
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

      {/* Step 1 — Sign in with Google */}
      <div className="sf-section">
        <div className="h">
          <span className="dot" />
          <span className="tt">Connect to Google BigQuery</span>
          {connected ? (
            <span className="badge ok small" style={{ marginLeft: 'auto' }}>
              Connected{email ? ` · ${email}` : ''}
            </span>
          ) : null}
        </div>
        <div className="sf-note" style={{ marginBottom: 10 }}>
          A Google sign-in window opens so you can authorize read access to BigQuery. The token is held{' '}
          <strong>only on the server</strong> for this session and is embedded on the published datasource so Tableau Cloud
          can connect / refresh.
        </div>
        {needsClient ? (
          <div className="sf-grid" style={{ marginBottom: 10 }}>
            <div className="full" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="secondary small"
                onClick={() => setShowHelp((v) => !v)}
                aria-expanded={showHelp}
              >
                {showHelp ? '▾' : '▸'} How do I create a Google OAuth Client ID & secret?
              </button>
              {savedInVault ? (
                <span className="badge ok small">Loaded from your vault</span>
              ) : null}
            </div>
            {showHelp ? (
              <div className="full sf-note" style={{ lineHeight: 1.5 }}>
                <ol style={{ margin: '4px 0 4px 18px', padding: 0 }}>
                  <li>
                    Open{' '}
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                      Google Cloud Console → APIs &amp; Services
                    </a>
                    . Pick or create a project — a personal project with <strong>“No organization”</strong> is easiest.
                  </li>
                  <li>
                    In <strong>APIs &amp; Services → Library</strong>, enable <strong>both</strong> the{' '}
                    <strong>BigQuery API</strong> and the <strong>Cloud Resource Manager API</strong>. Both are required —
                    without them the project/dataset lists stay empty.
                  </li>
                  <li>
                    Open the <strong>OAuth consent screen</strong> (new UI: <em>Google Auth Platform → Audience</em>) and set{' '}
                    <strong>User type = External</strong>. <em>Internal</em> only allows accounts in your Workspace org and
                    causes an <code>org_internal</code> error — if you can’t switch to External, the project is org-bound, so
                    use a personal “No organization” project instead.
                  </li>
                  <li>
                    Add the scopes <code>openid</code>, <code>email</code>, <code>.../auth/bigquery</code>, and{' '}
                    <code>.../auth/cloudplatformprojects.readonly</code>.
                  </li>
                  <li>
                    Add your Google account under <strong>Test users</strong> (a Testing-mode app only admits approved
                    testers) — <em>or</em> set <strong>Publishing status = In production</strong> to skip the test-user list
                    (Production also gives non-expiring refresh tokens; Testing expires them after 7 days).
                  </li>
                  <li>
                    <strong>Create Credentials → OAuth client ID → Web application.</strong>
                  </li>
                  <li>
                    Under <strong>Authorized redirect URIs</strong>, add exactly:{' '}
                    <code>{redirectUri || 'http://localhost:4000/api/connectors/bigquery/oauth/callback'}</code>
                  </li>
                  <li>
                    Copy the <strong>Client ID</strong> (and <strong>secret</strong>) into the fields below, then
                    click <strong>Save Creds in Vault</strong> so you never have to paste them again.
                  </li>
                </ol>
                <div className="small muted" style={{ marginTop: 6 }}>
                  On first sign-in Google may warn <em>“Google hasn’t verified this app.”</em> That’s expected for an
                  unverified test app — click <strong>Advanced → Continue</strong> to proceed.
                </div>
              </div>
            ) : null}
            <div className="full">
              <label>Google OAuth Client ID</label>
              <input
                placeholder="xxxxxxxx.apps.googleusercontent.com"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={connected}
              />
            </div>
            <div className="full">
              <label>
                Client secret <span className="muted">(optional — only for a confidential “Web application” client)</span>
              </label>
              <input
                type="password"
                placeholder={secretSaved ? '•••••••• saved — leave blank to reuse' : 'Leave blank for a public / PKCE client'}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                disabled={connected}
              />
            </div>
            {redirectUri ? (
              <div className="full small muted">
                In your Google Cloud OAuth client, add this exact <strong>Authorized redirect URI</strong>:{' '}
                <code>{redirectUri}</code>.
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button
            className={connected ? 'secondary' : ''}
            onClick={signIn}
            disabled={!canSignIn || savingVault}
          >
            {connecting ? <Busy label="Waiting for Google…" /> : connected ? 'Reconnect with Google' : 'Sign in with Google'}
          </button>
          {needsClient ? (
            <>
              <button
                type="button"
                className="secondary"
                onClick={saveCredsInVault}
                disabled={!clientId.trim() || connecting || savingVault}
              >
                {savingVault ? <Busy label="Saving…" /> : 'Save Creds in Vault'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={useSavedCreds}
                disabled={!vaultSaved || connecting || savingVault}
              >
                Use Saved Creds
              </button>
            </>
          ) : null}
          {!connected && !connectError ? (
            <span className="small muted">
              {needsClient && !clientId.trim() && !vaultSaved
                ? 'Enter your Google OAuth Client ID to enable sign-in.'
                : 'Opens a popup to authorize BigQuery access.'}
            </span>
          ) : null}
        </div>
        {vaultNotice ? <p className="small muted" style={{ marginTop: 8 }}>{vaultNotice}</p> : null}
        {connectError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {connectError}
          </div>
        ) : null}
      </div>

      {/* Step 2 — Billing project > Project > Dataset */}
      <div className={`sf-section ${connected ? '' : 'disabled'}`}>
        <div className="h">
          <span className="dot" />
          <span className="tt">Billing project · Project · Dataset</span>
          {loadingScope ? (
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              <Busy label={`Loading ${loadingScope}…`} />
            </span>
          ) : null}
        </div>
        <div className="sf-grid">
          <div>
            <label>Billing project</label>
            <select value={billingProjectId} onChange={(e) => setBillingProjectId(e.target.value)} disabled={!connected}>
              <option value="">Select a billing project…</option>
              {bqProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name === p.id ? p.id : `${p.name} (${p.id})`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Project (data)</label>
            <select value={dataProjectId} onChange={(e) => setDataProjectId(e.target.value)} disabled={!connected}>
              <option value="">Select a project…</option>
              {bqProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name === p.id ? p.id : `${p.name} (${p.id})`}
                </option>
              ))}
            </select>
          </div>
          <div className="full">
            <label>Dataset</label>
            <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} disabled={!dataProjectId}>
              <option value="">Select a dataset…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.location ? `${d.id} — ${d.location}` : d.id}
                </option>
              ))}
            </select>
          </div>
        </div>
        {scopeReady && tables.length > 0 ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            {tables.length} table{tables.length === 1 ? '' : 's'} in {datasetId}
          </div>
        ) : null}
      </div>

      {/* Step 3 — Model (shared with the Salesforce/Excel connectors). Remount on dataset change. */}
      <DataModelBuilder
        key={`${dataProjectId}/${datasetId}`}
        objects={modelObjects}
        describe={(name) => api.bigQueryDescribe(dataProjectId, datasetId, name).then((r) => r.fields)}
        onChange={setModel}
        disabled={!scopeReady}
        noun="table"
        nounPlural="tables"
      />

      {/* Step 4 — Publish */}
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
                name="bq-materialization"
                checked={materialization === 'extract'}
                onChange={() => setMaterialization('extract')}
              />
              Extract (bundled <code>.hyper</code>, refreshed after publish)
            </label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="bq-materialization"
                checked={materialization === 'live'}
                onChange={() => setMaterialization('live')}
              />
              Live (Tableau queries BigQuery directly)
            </label>
          </div>
          <div className="sf-note" style={{ marginTop: 8 }}>
            {materialization === 'extract'
              ? 'Rows are queried now and materialized into an extract. After publishing, a server-side extract refresh runs on Tableau Cloud.'
              : 'No data is copied — Tableau Cloud connects to BigQuery live over OAuth using your embedded credential.'}
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
            <input placeholder="e.g. BigQuery Orders DS" value={dsName} onChange={(e) => setDsName(e.target.value)} />
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
        <button style={{ marginTop: 14, width: '100%' }} onClick={submit} disabled={!ready || busy === 'bigquery-publish'}>
          {busy === 'bigquery-publish' ? <Busy label="Publishing…" /> : 'Create & publish datasource'}
        </button>
      </div>
    </div>
  );
}
