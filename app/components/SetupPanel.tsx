import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { DatasourceMetadataView, NamedItem, SessionContext } from '../types';
import { Busy, ErrorPanel, Collapsible } from './common';
import { DataModelBuilder, type DataModel } from './DataModelBuilder';
import { ExcelBuild } from './ExcelBuild';
import { BigQueryBuild } from './BigQueryBuild';
import { DataCloudBuild } from './DataCloudBuild';
import { SnowflakeBuild } from './SnowflakeBuild';

/** Multi-object data-modeling mode: Tableau relationships vs a physical join. */
type SfMode = 'relationship' | 'join';

/** A data-modeling edge between two objects (built by {@link SalesforceBuild}). */
interface SfRelationship {
  leftObject: string;
  leftField: string;
  rightObject: string;
  rightField: string;
  cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  joinType: 'inner' | 'left' | 'right' | 'full';
}

/** Which connector the "Build datasource" flow targets. */
type Connector = 'salesforce' | 'excel' | 'bigquery' | 'datacloud' | 'snowflake';

/**
 * Connect + select destination project + select and LOCK the datasource.
 * The datasource lock is the single source of truth; changing it requires an
 * explicit confirmation (change guard).
 */
export function SetupPanel({ ctx, onChange }: { ctx: SessionContext; onChange: (ctx: SessionContext) => void }): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<NamedItem[]>([]);
  const [datasources, setDatasources] = useState<NamedItem[]>([]);
  const [selDs, setSelDs] = useState('');
  const [metadata, setMetadata] = useState<DatasourceMetadataView | null>(null);
  const [confirmChange, setConfirmChange] = useState(false);

  // Datasource acquisition mode: use an existing published datasource, or build a
  // new one from a connector (Salesforce). The build flow ends by locking the
  // freshly published datasource, so the downstream dashboard flow is unchanged.
  const [mode, setMode] = useState<'published' | 'build'>('published');
  // Which connector the build flow targets (Salesforce or Excel).
  const [connector, setConnector] = useState<Connector>('salesforce');
  // Build-datasource inputs. Salesforce credentials are used ONLY to read the object
  // schema (describe) so fields are available immediately; they are NOT embedded. The
  // published datasource connects via the user's SAVED Salesforce credential on Tableau.
  const [sfUrl, setSfUrl] = useState('');
  const [sfUsername, setSfUsername] = useState('');
  const [sfPassword, setSfPassword] = useState('');
  const [sfToken, setSfToken] = useState('');
  const [sfProjectId, setSfProjectId] = useState('');
  const [sfDsName, setSfDsName] = useState('');
  const [sfOverwrite, setSfOverwrite] = useState(false);
  // Emit server-oauth='server-custom' (a custom Salesforce OAuth client on the site,
  // as in the reference). Uncheck to use Tableau's built-in Salesforce OAuth client.
  const [sfServerCustom, setSfServerCustom] = useState(true);

  async function refresh(): Promise<void> {
    const c = await api.context();
    onChange(c);
  }

  async function connect(): Promise<void> {
    setError(null);
    setBusy('connect');
    try {
      await api.connect();
      const [p, d] = await Promise.all([api.projects(), api.datasources()]);
      setProjects(p.items);
      setDatasources(d.items);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (ctx.connected && projects.length === 0) {
      void connect();
    }
  }, []);

  async function selectProject(id: string): Promise<void> {
    const proj = projects.find((p) => p.id === id);
    if (!proj) return;
    setBusy('project');
    setError(null);
    try {
      await api.selectProject(proj.id, proj.name);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function lock(): Promise<void> {
    if (!selDs) return;
    setBusy('lock');
    setError(null);
    try {
      await api.lockDatasource(selDs);
      const ds = datasources.find((d) => d.id === selDs);
      if (ds) {
        const md = await api.metadata(ds.id, ds.name);
        setMetadata(md);
      }
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  // After ANY connector publish + lock, refresh context and load the locked datasource's
  // metadata for display (best-effort — metadata may lag indexing for a brand-new source).
  async function loadLockedMetadataAndRefresh(): Promise<void> {
    const c = await api.context();
    if (c.datasourceLock) {
      try {
        const md = await api.metadata(c.datasourceLock.datasourceId, c.datasourceLock.datasourceName);
        setMetadata(md);
      } catch {
        /* metadata may lag indexing for a brand-new datasource */
      }
    }
    onChange(c);
  }

  // Success handler for the Excel build flow: surface the extract status, then refresh.
  async function afterBuildPublished(res: {
    datasource: { name: string };
    extract?: { state?: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
  }): Promise<void> {
    const ex = res.extract;
    setNotice(ex?.message ? `Published "${res.datasource.name}". ${ex.message}` : `Published "${res.datasource.name}".`);
    await loadLockedMetadataAndRefresh();
  }

  async function publishSalesforce(tables: string[], relationships: SfRelationship[], mode: SfMode): Promise<void> {
    if (!sfUrl || !sfUsername || !sfPassword || tables.length === 0 || !sfProjectId || !sfDsName) return;
    setBusy('sf-publish');
    setError(null);
    setNotice(null);
    try {
      const res = await api.salesforcePublish({
        credentials: { url: sfUrl, username: sfUsername, password: sfPassword, token: sfToken || undefined },
        tables,
        relationships,
        mode,
        projectId: sfProjectId,
        datasourceName: sfDsName,
        overwrite: sfOverwrite,
        serverOauthCustom: sfServerCustom,
      });
      // Report the server-side extract creation status (Salesforce datasources use an extract).
      const ex = res.extract;
      if (ex?.state === 'succeeded') {
        setNotice(`Published "${res.datasource.name}" and created its Salesforce extract.`);
      } else if (ex?.state === 'pending') {
        setNotice(
          `Published "${res.datasource.name}". The Salesforce extract is still building on Tableau Cloud — it will be ready shortly.`,
        );
      } else {
        setNotice(
          `Published "${res.datasource.name}", but the extract could not be created${ex?.message ? ` (${ex.message})` : ''}. Verify your saved Salesforce credential on Tableau Cloud, then re-publish with Overwrite.`,
        );
      }
      // Datasource is now published + locked; load its metadata for display.
      await loadLockedMetadataAndRefresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function unlock(): Promise<void> {
    setBusy('unlock');
    setError(null);
    try {
      await api.unlockDatasource();
      setMetadata(null);
      setSelDs('');
      setConfirmChange(false);
      setSfUrl('');
      setSfUsername('');
      setSfPassword('');
      setSfToken('');
      setSfDsName('');
      setSfProjectId('');
      setSfOverwrite(false);
      setSfServerCustom(true);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>Connection & datasource</h2>
      {!ctx.connected ? (
        <div className="row">
          <button onClick={connect} disabled={busy === 'connect'}>
            {busy === 'connect' ? <Busy label="Connecting…" /> : 'Connect to Tableau Cloud'}
          </button>
        </div>
      ) : (
        <div className="col">
          <div className="badge ok" style={{ alignSelf: 'flex-start' }}>Connected</div>

          <div>
            <label>Target project (publishing destination)</label>
            <select
              value={ctx.projectContext?.projectId ?? ''}
              onChange={(e) => selectProject(e.target.value)}
              disabled={busy === 'project'}
            >
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Datasource (source of truth)</label>
            {ctx.datasourceLock ? (
              <div className="lock">
                <span className="locked">🔒 Locked:</span>
                <span>{ctx.datasourceLock.datasourceName}</span>
                <button className="ghost" onClick={() => setConfirmChange(true)} disabled={busy !== null}>
                  Change…
                </button>
              </div>
            ) : (
              <>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="radio"
                      name="ds-mode"
                      checked={mode === 'published'}
                      onChange={() => setMode('published')}
                    />
                    Use Published datasource
                  </label>
                  <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="radio" name="ds-mode" checked={mode === 'build'} onChange={() => setMode('build')} />
                    Build datasource
                  </label>
                </div>

                {mode === 'published' ? (
                  <div className="row">
                    <select value={selDs} onChange={(e) => setSelDs(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Select a datasource…</option>
                      {datasources.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                          {d.projectName ? ` — ${d.projectName}` : ''}
                        </option>
                      ))}
                    </select>
                    <button onClick={lock} disabled={!selDs || busy === 'lock'}>
                      {busy === 'lock' ? <Busy label="Locking…" /> : 'Lock'}
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="row" style={{ marginBottom: 10 }}>
                      <div style={{ flex: 1 }}>
                        <label className="small">Connector</label>
                        <select value={connector} onChange={(e) => setConnector(e.target.value as Connector)} style={{ width: '100%' }}>
                          <option value="salesforce">Salesforce</option>
                          <option value="excel">Excel (.xlsx)</option>
                          <option value="bigquery">Google BigQuery</option>
                          <option value="datacloud">Salesforce Data Cloud</option>
                          <option value="snowflake">Snowflake</option>
                        </select>
                      </div>
                    </div>
                    {connector === 'salesforce' ? (
                      <SalesforceBuild
                        busy={busy}
                        url={sfUrl}
                        setUrl={setSfUrl}
                        username={sfUsername}
                        setUsername={setSfUsername}
                        password={sfPassword}
                        setPassword={setSfPassword}
                        token={sfToken}
                        setToken={setSfToken}
                        projects={projects}
                        projectId={sfProjectId}
                        setProjectId={setSfProjectId}
                        dsName={sfDsName}
                        setDsName={setSfDsName}
                        overwrite={sfOverwrite}
                        setOverwrite={setSfOverwrite}
                        serverCustom={sfServerCustom}
                        setServerCustom={setSfServerCustom}
                        onPublish={publishSalesforce}
                      />
                    ) : connector === 'excel' ? (
                      <ExcelBuild busy={busy} setBusy={setBusy} projects={projects} onPublished={afterBuildPublished} />
                    ) : connector === 'bigquery' ? (
                      <BigQueryBuild busy={busy} setBusy={setBusy} projects={projects} onPublished={afterBuildPublished} />
                    ) : connector === 'datacloud' ? (
                      <DataCloudBuild busy={busy} setBusy={setBusy} projects={projects} onPublished={afterBuildPublished} />
                    ) : (
                      <SnowflakeBuild busy={busy} setBusy={setBusy} projects={projects} onPublished={afterBuildPublished} />
                    )}
                  </>
                )}
              </>
            )}
          </div>

          {metadata ? (
            <div>
              <div className="small muted">
                {metadata.metadataApiAvailable
                  ? `${metadata.fieldCount} fields discovered via the Metadata API`
                  : 'Metadata API unavailable — fields could not be listed'}
              </div>
              {!metadata.metadataApiAvailable && metadata.unavailableReason ? (
                <div className="warnbox small" style={{ marginTop: 6 }}>
                  {metadata.unavailableReason}
                </div>
              ) : null}
              {metadata.metadataApiAvailable ? (
                <Collapsible title="Datasource fields" badge={metadata.fieldCount} defaultOpen={false}>
                  <FieldPills title="Dimensions" cls="dim" fields={metadata.dimensions.map((f) => f.name)} />
                  <FieldPills title="Measures" cls="mea" fields={metadata.measures.map((f) => f.name)} />
                  <FieldPills title="Dates" cls="date" fields={metadata.dates.map((f) => f.name)} />
                </Collapsible>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {notice ? (
        <div className="sf-note small" style={{ marginTop: 8 }}>
          {notice}
          <button className="link" style={{ marginLeft: 8 }} onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      <ErrorPanel error={error} onDismiss={() => setError(null)} />

      {confirmChange ? (
        <div className="warnbox" style={{ marginTop: 10 }}>
          <strong>Change the locked datasource?</strong>
          <p className="small">
            The datasource is the single source of truth for your dashboard. Changing it unlocks the datasource and
            clears the current plan{ctx.workbook ? ' and detaches the published dashboard' : ''}, so you can select
            and lock a different datasource.
          </p>
          <div className="row">
            <button className="danger" onClick={unlock} disabled={busy === 'unlock'}>
              {busy === 'unlock' ? <Busy label="Unlocking…" /> : 'Yes, change datasource'}
            </button>
            <button className="ghost" onClick={() => setConfirmChange(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The "Build datasource" sub-flow for the Salesforce connector.
 *
 * Salesforce credentials are used ONLY to read the object's schema (a `describe`
 * call) so the dashboard flow has real fields immediately — they are NOT embedded in
 * the published datasource. The server generates a LIVE Salesforce `.tds` and
 * publishes it using the publishing user's SAVED Salesforce credential on Tableau
 * Cloud. On publish the parent locks the new datasource and the normal dashboard flow
 * proceeds unchanged.
 */
function SalesforceBuild({
  busy,
  url,
  setUrl,
  username,
  setUsername,
  password,
  setPassword,
  token,
  setToken,
  projects,
  projectId,
  setProjectId,
  dsName,
  setDsName,
  overwrite,
  setOverwrite,
  serverCustom,
  setServerCustom,
  onPublish,
}: {
  busy: string | null;
  url: string;
  setUrl: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
  projects: NamedItem[];
  projectId: string;
  setProjectId: (v: string) => void;
  dsName: string;
  setDsName: (v: string) => void;
  overwrite: boolean;
  setOverwrite: (v: boolean) => void;
  serverCustom: boolean;
  setServerCustom: (v: boolean) => void;
  onPublish: (tables: string[], relationships: SfRelationship[], mode: SfMode) => void;
}): React.ReactElement {
  // Connecting establishes the transient Salesforce session used to list objects and
  // describe fields for the join-field dropdowns. Publishing re-logs in server-side.
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [objects, setObjects] = useState<Array<{ name: string; label: string }>>([]);
  const connected = objects.length > 0;

  // Modeling (primary + additional objects, relationships/join, mode) is owned by the shared
  // DataModelBuilder; we only track the model it emits.
  const [model, setModel] = useState<DataModel>({ objects: [], relationships: [], mode: 'relationship', valid: false });

  async function connectSf(): Promise<void> {
    if (!url || !username || !password) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const res = await api.salesforceConnect({ url, username, password, token: token || undefined });
      setObjects(res.tables);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not connect to Salesforce.');
      setObjects([]);
    } finally {
      setConnecting(false);
    }
  }

  const ready = Boolean(model.valid && projectId && dsName);

  function submit(): void {
    if (!ready) return;
    onPublish(model.objects, model.relationships as SfRelationship[], model.mode as SfMode);
  }

  return (
    <div className="sf">
      <div className="sf-head">
        <div className="sf-logo">SF</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">Salesforce data source</div>
          <div className="s">Connect, model your objects, then publish an extract to Tableau Cloud.</div>
        </div>
      </div>

      <div className="sf-steps">
        <div className={`st ${connected ? 'done' : 'active'}`}>
          <span className="n">{connected ? '✓' : '1'}</span> Connect
        </div>
        <span className="sep" />
        <div className={`st ${model.valid ? 'done' : connected ? 'active' : ''}`}>
          <span className="n">{model.valid ? '✓' : '2'}</span> Model
        </div>
        <span className="sep" />
        <div className={`st ${ready ? 'active' : ''}`}>
          <span className="n">3</span> Publish
        </div>
      </div>

      {/* Step 1 — Connect */}
      <div className="sf-section">
        <div className="h">
          <span className="dot" />
          <span className="tt">Connect to Salesforce</span>
          {connected ? (
            <span className="badge ok small" style={{ marginLeft: 'auto' }}>
              Connected · {objects.length} objects
            </span>
          ) : null}
        </div>
        <div className="sf-note" style={{ marginBottom: 10 }}>
          Your credentials are used <strong>only to read object fields</strong> — they are never embedded. The published
          datasource connects via your <strong>saved Salesforce credential</strong> on Tableau Cloud (Account Settings →
          Saved Credentials).
        </div>
        <div className="sf-grid">
          <div className="full">
            <label>Salesforce login URL</label>
            <input placeholder="https://login.salesforce.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
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
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className={connected ? 'secondary' : ''}
            onClick={connectSf}
            disabled={!url || !username || !password || connecting}
          >
            {connecting ? <Busy label="Connecting…" /> : connected ? 'Reconnect' : 'Connect to Salesforce'}
          </button>
          {!connected && !connectError ? (
            <span className="small muted">Loads your objects and their fields for modeling.</span>
          ) : null}
        </div>
        {connectError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {connectError}
          </div>
        ) : null}
      </div>

      {/* Step 2 — Model (shared with the Excel connector) */}
      <DataModelBuilder
        objects={objects}
        describe={(name) => api.salesforceDescribe(name).then((r) => r.fields)}
        onChange={setModel}
        disabled={!connected}
        noun="object"
        nounPlural="objects"
      />

      {/* Step 3 — Publish */}
      <div className={`sf-section ${connected ? '' : 'disabled'}`}>
        <div className="h">
          <span className="dot" />
          <span className="tt">Publish to Tableau Cloud</span>
        </div>
        <div className="sf-grid">
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
            <input placeholder="e.g. Salesforce Account DS" value={dsName} onChange={(e) => setDsName(e.target.value)} />
          </div>
        </div>
        <label className="checkline" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite if a datasource with this name already exists</span>
        </label>
        <label className="checkline" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={serverCustom} onChange={(e) => setServerCustom(e.target.checked)} />
          <span>Use my organization's Salesforce OAuth client (configured on Tableau Cloud)</span>
        </label>
        <div className="sf-note" style={{ marginTop: 8 }}>
          When enabled, the datasource authenticates with the custom Salesforce OAuth client a Tableau admin registered on
          your Tableau Cloud site (Settings → Connected Apps / OAuth Clients). Uncheck to use Tableau's built-in Salesforce
          OAuth client. This is not the same as embedding a password.
        </div>
        <button style={{ marginTop: 14, width: '100%' }} onClick={submit} disabled={!ready || busy === 'sf-publish'}>
          {busy === 'sf-publish' ? <Busy label="Publishing…" /> : 'Create & publish datasource'}
        </button>
      </div>
    </div>
  );
}

function FieldPills({ title, cls, fields }: { title: string; cls: string; fields: string[] }): React.ReactElement {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="small muted">
        {title} ({fields.length})
      </div>
      <div className="pills">
        {fields.slice(0, 40).map((f) => (
          <span key={f} className={`pill ${cls}`}>
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}
