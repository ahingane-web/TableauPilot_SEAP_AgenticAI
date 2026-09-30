import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { NamedItem } from '../types';
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
 * Login copies the Salesforce username/password form (org URL, username, password, optional
 * security token) but lives in this file — SalesforceBuild is not reused. After connect the
 * user picks a Data Space and object category; objects feed the shared DataModelBuilder.
 * Live publishes a bare `salesforce-genie` `.tds`; Extract materializes a local `.hyper`.
 * On success the parent locks the new datasource. No Salesforce/Excel/BigQuery internals
 * are involved.
 */
export function DataCloudBuild({
  busy,
  setBusy,
  projects,
  onPublished,
}: {
  busy: string | null;
  setBusy: (v: string | null) => void;
  projects: NamedItem[];
  onPublished: (res: {
    datasource: { name: string };
    extract?: { state?: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
  }) => Promise<void>;
}): React.ReactElement {
  const [url, setUrl] = useState('https://login.salesforce.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

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

  async function connect(): Promise<void> {
    if (!url || !username || !password) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await api.dataCloudConnect({ url, username, password, token: token || undefined });
      const spaces = await api.dataCloudDataSpaces();
      setDataSpaces(spaces.dataSpaces);
      setConnected(true);
      setDataSpace('');
      setObjects([]);
      setModel({ objects: [], relationships: [], mode: 'relationship', valid: false });
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
  const ready = Boolean(model.valid && projectId && dsName && dataSpace);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy('datacloud-publish');
    setPublishError(null);
    try {
      const res = await api.dataCloudPublish({
        credentials: { url, username, password, token: token || undefined },
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
          <div className="s">Connect, pick a data space and objects, then publish a live or extract datasource.</div>
        </div>
      </div>

      <div className="sf-steps">
        <div className={`st ${connected ? 'done' : 'active'}`}>
          <span className="n">{connected ? '✓' : '1'}</span> Connect
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
              Connected
            </span>
          ) : null}
        </div>
        <div className="sf-note" style={{ marginBottom: 10 }}>
          Your credentials are used <strong>only to read Data Cloud metadata and (for extracts) rows</strong> — they are
          never embedded. The published datasource connects via your{' '}
          <strong>saved Salesforce Data Cloud credential</strong> on Tableau Cloud (Account Settings → Saved Credentials).
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
            onClick={connect}
            disabled={!url || !username || !password || connecting}
          >
            {connecting ? <Busy label="Connecting…" /> : connected ? 'Reconnect' : 'Connect to Data Cloud'}
          </button>
          {!connected && !connectError ? (
            <span className="small muted">Loads your data spaces so you can pick objects to model.</span>
          ) : null}
        </div>
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
