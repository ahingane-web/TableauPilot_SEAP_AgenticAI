import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { DatasourceMetadataView, NamedItem, SessionContext } from '../types';
import { Busy, ErrorPanel, Collapsible } from './common';

/** Relationship cardinality options shown in the relationship builder. */
type SfCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

/** SQL join type options shown in the physical-join builder. */
type SfJoinType = 'inner' | 'left' | 'right' | 'full';

/** Multi-object data-modeling mode: Tableau relationships vs a physical join. */
type SfMode = 'relationship' | 'join';

/** A data-modeling edge between two objects (built by {@link SalesforceBuild}). */
interface SfRelationship {
  leftObject: string;
  leftField: string;
  rightObject: string;
  rightField: string;
  cardinality: SfCardinality;
  joinType: SfJoinType;
}

/** A described Salesforce field (name/label/type), used for the join-field dropdowns. */
interface SfFieldInfo {
  name: string;
  label: string;
  type: string;
}

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
/** A table row in the relationship builder. Index 0 is the primary object; each later
 * row carries the relationship (`rel`) that connects it to a prior table. */
interface TableDraft {
  object: string;
  rel?: { leftObject: string; leftField: string; rightField: string; cardinality: SfCardinality; joinType: SfJoinType };
}

const CARDINALITY_OPTIONS: Array<{ value: SfCardinality; label: string }> = [
  { value: 'many-to-many', label: 'Many-to-many (neither unique)' },
  { value: 'many-to-one', label: 'Many-to-one (right side unique)' },
  { value: 'one-to-many', label: 'One-to-many (left side unique)' },
  { value: 'one-to-one', label: 'One-to-one (both unique)' },
];

const JOIN_TYPE_OPTIONS: Array<{ value: SfJoinType; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'inner', label: 'Inner' },
  { value: 'full', label: 'Full Outer' },
];

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

  const [relEnabled, setRelEnabled] = useState(false);
  // Multi-object data-modeling mode: Tableau relationships (default) vs a physical join.
  const [mode, setMode] = useState<SfMode>('relationship');
  const [tables, setTables] = useState<TableDraft[]>([{ object: '' }]);
  const [fieldsByObject, setFieldsByObject] = useState<Record<string, SfFieldInfo[]>>({});
  const [describing, setDescribing] = useState<Record<string, boolean>>({});

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

  async function loadFields(object: string): Promise<void> {
    const name = object.trim();
    if (!name || fieldsByObject[name] || describing[name]) return;
    setDescribing((p) => ({ ...p, [name]: true }));
    try {
      const res = await api.salesforceDescribe(name);
      setFieldsByObject((p) => ({ ...p, [name]: res.fields }));
    } catch {
      setFieldsByObject((p) => ({ ...p, [name]: [] }));
    } finally {
      setDescribing((p) => ({ ...p, [name]: false }));
    }
  }

  function setPrimaryObject(value: string): void {
    setTables((prev) => [{ ...prev[0], object: value }, ...prev.slice(1)]);
    void loadFields(value);
  }

  function toggleRelationships(enabled: boolean): void {
    setRelEnabled(enabled);
    if (!enabled) setTables((prev) => prev.slice(0, 1)); // collapse back to the primary object
  }

  function addTable(): void {
    setTables((prev) => {
      const priorObject = prev[0]?.object ?? '';
      return [
        ...prev,
        {
          object: '',
          rel: { leftObject: priorObject, leftField: '', rightField: '', cardinality: 'many-to-many', joinType: 'left' },
        },
      ];
    });
  }

  function removeTable(index: number): void {
    setTables((prev) => prev.filter((_, i) => i !== index));
  }

  function setTableObject(index: number, value: string): void {
    setTables((prev) => prev.map((t, i) => (i === index ? { ...t, object: value } : t)));
    void loadFields(value);
  }

  function updateRel(index: number, patch: Partial<NonNullable<TableDraft['rel']>>): void {
    setTables((prev) =>
      prev.map((t, i) =>
        i === index && t.rel ? { ...t, rel: { ...t.rel, ...patch } } : t,
      ),
    );
    if (patch.leftObject) void loadFields(patch.leftObject);
  }

  const visibleTables = relEnabled ? tables : tables.slice(0, 1);
  const selectedObjects = visibleTables.map((t) => t.object.trim());
  const allHaveObject = selectedObjects.every((o) => o.length > 0);
  const hasDupes = new Set(selectedObjects).size !== selectedObjects.length;
  const relsComplete =
    !relEnabled ||
    tables.slice(1).every((t) => t.rel && t.rel.leftObject && t.rel.leftField && t.rel.rightField && t.object.trim());
  const enoughTables = !relEnabled || tables.length >= 2;
  const modelDone = Boolean(connected && allHaveObject && !hasDupes && relsComplete && enoughTables);
  const ready = Boolean(modelDone && projectId && dsName);

  function submit(): void {
    if (!ready) return;
    const relationships: SfRelationship[] = relEnabled
      ? tables
          .slice(1)
          .filter((t) => t.object.trim() && t.rel)
          .map((t) => ({
            leftObject: t.rel!.leftObject,
            leftField: t.rel!.leftField,
            rightObject: t.object.trim(),
            rightField: t.rel!.rightField,
            cardinality: t.rel!.cardinality,
            joinType: t.rel!.joinType,
          }))
      : [];
    // Single-object builds have no data-modeling mode; default to 'relationship'.
    onPublish(selectedObjects, relationships, relEnabled ? mode : 'relationship');
  }

  const ObjectSelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }): React.ReactElement => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select an object…</option>
      {objects.map((o) => (
        <option key={o.name} value={o.name}>
          {o.label === o.name ? o.name : `${o.label} (${o.name})`}
        </option>
      ))}
    </select>
  );

  const FieldSelect = ({
    object,
    value,
    onChange,
  }: {
    object: string;
    value: string;
    onChange: (v: string) => void;
  }): React.ReactElement => {
    const fields = fieldsByObject[object.trim()] ?? [];
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!object || describing[object.trim()]}>
        <option value="">{describing[object.trim()] ? 'Loading fields…' : 'Select a field…'}</option>
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label === f.name ? f.name : `${f.label} (${f.name})`}
          </option>
        ))}
      </select>
    );
  };

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
        <div className={`st ${modelDone ? 'done' : connected ? 'active' : ''}`}>
          <span className="n">{modelDone ? '✓' : '2'}</span> Model
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

      {/* Step 2 — Model */}
      <div className={`sf-section ${connected ? '' : 'disabled'}`}>
        <div className="h">
          <span className="dot" />
          <span className="tt">Model your data</span>
        </div>

        <div>
          <label>{relEnabled ? 'Primary object (Table 1)' : 'Salesforce object'}</label>
          <ObjectSelect value={tables[0]?.object ?? ''} onChange={setPrimaryObject} />
        </div>

        <label className="switch" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={relEnabled}
            onChange={(e) => toggleRelationships(e.target.checked)}
            disabled={!tables[0]?.object}
          />
          <span className="track" />
          <span>Combine multiple objects (data modeling)</span>
        </label>

        {relEnabled ? (
          <div className="col" style={{ gap: 12, marginTop: 14 }}>
            <div>
              <label>Model type</label>
              <div className="segmented">
                <button type="button" className={mode === 'relationship' ? 'on' : ''} onClick={() => setMode('relationship')}>
                  Relationship
                </button>
                <button type="button" className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>
                  Join
                </button>
              </div>
              <div className="hint">
                {mode === 'relationship'
                  ? 'Recommended. Objects stay separate and are related by cardinality; Tableau chooses the join at query time.'
                  : 'Objects are flattened into one table using the chosen SQL join type.'}
              </div>
            </div>

            {tables.slice(1).map((t, idx) => {
              const i = idx + 1; // index in `tables`
              const priorObjects = tables.slice(0, i).map((p) => p.object.trim()).filter(Boolean);
              const leftObject = t.rel?.leftObject ?? '';
              return (
                <div key={i} className="tablecard">
                  <div className="th">
                    <span className="lbl">
                      <span className="num">{i + 1}</span> Table {i + 1}
                    </span>
                    <button type="button" className="linkbtn" onClick={() => removeTable(i)}>
                      Remove
                    </button>
                  </div>
                  <div>
                    <label>Object</label>
                    <ObjectSelect value={t.object} onChange={(v) => setTableObject(i, v)} />
                  </div>
                  <label style={{ marginTop: 10 }}>{mode === 'join' ? 'Join condition' : 'Relationship condition'}</label>
                  <div className="joinrow">
                    <select value={leftObject} onChange={(e) => updateRel(i, { leftObject: e.target.value, leftField: '' })}>
                      <option value="">{mode === 'join' ? 'Join to…' : 'Relate to…'}</option>
                      {priorObjects.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                    <FieldSelect object={leftObject} value={t.rel?.leftField ?? ''} onChange={(v) => updateRel(i, { leftField: v })} />
                    <span className="eq">=</span>
                    <FieldSelect object={t.object} value={t.rel?.rightField ?? ''} onChange={(v) => updateRel(i, { rightField: v })} />
                  </div>
                  <div style={{ marginTop: 10 }}>
                    {mode === 'join' ? (
                      <>
                        <label>Join type</label>
                        <select
                          value={t.rel?.joinType ?? 'left'}
                          onChange={(e) => updateRel(i, { joinType: e.target.value as SfJoinType })}
                        >
                          {JOIN_TYPE_OPTIONS.map((j) => (
                            <option key={j.value} value={j.value}>
                              {j.label}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <>
                        <label>Cardinality</label>
                        <select
                          value={t.rel?.cardinality ?? 'many-to-many'}
                          onChange={(e) => updateRel(i, { cardinality: e.target.value as SfCardinality })}
                        >
                          {CARDINALITY_OPTIONS.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            <button type="button" className="addbtn" onClick={addTable} disabled={!tables[0]?.object}>
              + Add table
            </button>
            {hasDupes ? <div className="warnbox small">Each object can be added only once.</div> : null}
          </div>
        ) : null}
      </div>

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
