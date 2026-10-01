import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { CredentialSummary, NamedItem } from '../types';
import { Busy } from './common';
import { DataModelBuilder, type DataModel } from './DataModelBuilder';

/**
 * The "Build datasource" sub-flow for the Snowflake connector.
 *
 * Login collects Server URL, Warehouse, Username, and Password. After connect the user
 * picks Warehouse → Database → Schema; tables feed the shared DataModelBuilder.
 * Live publishes a bare `class='snowflake'` Username Password `.tds`; Extract
 * materializes a local `.hyper`. On success the parent locks the new datasource.
 * No Salesforce/Excel/BigQuery/Data Cloud internals are involved.
 */
export function SnowflakeBuild({
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
  const [loginWarehouse, setLoginWarehouse] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const [warehouses, setWarehouses] = useState<Array<{ name: string; label: string }>>([]);
  const [databases, setDatabases] = useState<Array<{ name: string; label: string }>>([]);
  const [schemas, setSchemas] = useState<Array<{ name: string; label: string }>>([]);
  const [warehouse, setWarehouse] = useState('');
  const [database, setDatabase] = useState('');
  const [schema, setSchema] = useState('');
  const [tables, setTables] = useState<Array<{ name: string; label: string }>>([]);
  const [loadingScope, setLoadingScope] = useState<string | null>(null);

  const [model, setModel] = useState<DataModel>({ objects: [], relationships: [], mode: 'relationship', valid: false });
  const [materialization, setMaterialization] = useState<'live' | 'extract'>('extract');
  const [projectId, setProjectId] = useState('');
  const [dsName, setDsName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [savingVault, setSavingVault] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<string | null>(null);
  const vaultSaved = Boolean(vaultSummary?.hasSnowflake);

  async function connect(): Promise<void> {
    if (!url || !loginWarehouse || !username || !password) return;
    setConnecting(true);
    setConnectError(null);
    setVaultNotice(null);
    try {
      const res = await api.snowflakeConnect({ url, warehouse: loginWarehouse, username, password });
      const listed = await api.snowflakeWarehouses();
      setWarehouses(listed.warehouses);
      setConnected(true);
      const preferred = (res.warehouse || loginWarehouse).trim();
      const match = listed.warehouses.find((w) => w.name.toUpperCase() === preferred.toUpperCase());
      setWarehouse(match?.name || preferred);
      setDatabase('');
      setSchema('');
      setDatabases([]);
      setSchemas([]);
      setTables([]);
      setModel({ objects: [], relationships: [], mode: 'relationship', valid: false });
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not connect to Snowflake.');
      setConnected(false);
      setWarehouses([]);
      setDatabases([]);
      setSchemas([]);
      setTables([]);
    } finally {
      setConnecting(false);
    }
  }

  async function saveCredsInVault(): Promise<void> {
    if (!url || !loginWarehouse || !username || !password) {
      setConnectError('Fill server URL, warehouse, username, and password to save.');
      return;
    }
    setSavingVault(true);
    setConnectError(null);
    try {
      await api.saveSnowflakeAccount({ url, warehouse: loginWarehouse, username, password });
      await onVaultSaved();
      setVaultNotice('Saved in Vault.');
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not save Snowflake credentials.');
    } finally {
      setSavingVault(false);
    }
  }

  async function useSavedCreds(): Promise<void> {
    if (!vaultSaved) return;
    setUrl(vaultSummary?.snowflakeUrl ?? '');
    setLoginWarehouse(vaultSummary?.snowflakeWarehouse ?? '');
    setUsername(vaultSummary?.snowflakeUsername ?? '');
    setPassword('');
    setConnecting(true);
    setConnectError(null);
    setVaultNotice(null);
    try {
      const res = await api.snowflakeConnect({});
      const listed = await api.snowflakeWarehouses();
      setWarehouses(listed.warehouses);
      setConnected(true);
      const preferred = (res.warehouse || vaultSummary?.snowflakeWarehouse || '').trim();
      const match = listed.warehouses.find((w) => w.name.toUpperCase() === preferred.toUpperCase());
      setWarehouse(match?.name || preferred);
      setDatabase('');
      setSchema('');
      setDatabases([]);
      setSchemas([]);
      setTables([]);
      setModel({ objects: [], relationships: [], mode: 'relationship', valid: false });
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : 'Could not connect to Snowflake.');
      setConnected(false);
      setWarehouses([]);
      setDatabases([]);
      setSchemas([]);
      setTables([]);
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    if (!connected || !warehouse) {
      setDatabases([]);
      setDatabase('');
      return;
    }
    let cancelled = false;
    setLoadingScope('databases');
    api
      .snowflakeDatabases(warehouse)
      .then((res) => {
        if (cancelled) return;
        setDatabases(res.databases);
        setConnectError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setConnectError(e instanceof Error ? e.message : 'Could not list Snowflake databases.');
        setDatabases([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, warehouse]);

  useEffect(() => {
    if (!connected || !warehouse || !database) {
      setSchemas([]);
      setSchema('');
      return;
    }
    let cancelled = false;
    setLoadingScope('schemas');
    api
      .snowflakeSchemas(warehouse, database)
      .then((res) => {
        if (cancelled) return;
        setSchemas(res.schemas);
        setConnectError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setConnectError(e instanceof Error ? e.message : 'Could not list Snowflake schemas.');
        setSchemas([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, warehouse, database]);

  useEffect(() => {
    if (!connected || !warehouse || !database || !schema) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoadingScope('tables');
    api
      .snowflakeTables(warehouse, database, schema)
      .then((res) => {
        if (cancelled) return;
        setTables(res.tables.map((t) => ({ name: t.name, label: t.label })));
        setConnectError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setConnectError(e instanceof Error ? e.message : 'Could not list Snowflake tables.');
        setTables([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingScope(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, warehouse, database, schema]);

  const scopeReady = connected && Boolean(warehouse && database && schema) && tables.length > 0;
  const ready = Boolean(model.valid && projectId && dsName && warehouse && database && schema);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy('snowflake-publish');
    setPublishError(null);
    try {
      const res = await api.snowflakePublish({
        credentials: password
          ? { url, warehouse: loginWarehouse, username, password }
          : {},
        warehouse,
        database,
        schema,
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
      setPublishError(e instanceof Error ? e.message : 'Could not publish the Snowflake datasource.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sf">
      <div className="sf-head">
        <div className="sf-logo">SN</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">Snowflake</div>
          <div className="s">Connect, pick warehouse / database / schema, then publish a live or extract datasource.</div>
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
          <span className="tt">Connect to Snowflake</span>
          {connected ? (
            <span className="badge ok small" style={{ marginLeft: 'auto' }}>
              Connected
            </span>
          ) : null}
        </div>
        <div className="sf-note" style={{ marginBottom: 10 }}>
          Credentials are used <strong>only to list Snowflake metadata and (for extracts) rows</strong>, then embedded
          on the published Tableau connection as <strong>Username Password</strong>. They are never logged or sent to
          the LLM.
        </div>
        <div className="sf-grid">
            <div className="full">
              <label>Server URL</label>
              <input
                placeholder="xy12345.snowflakecomputing.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="full">
              <label>Warehouse</label>
              <input
                placeholder="COMPUTE_WH"
                autoComplete="off"
                value={loginWarehouse}
                onChange={(e) => setLoginWarehouse(e.target.value)}
              />
            </div>
            <div>
              <label>Username</label>
              <input
                placeholder="SNOWFLAKE_USER"
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
          </div>
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <button
            className={connected ? 'secondary' : ''}
            onClick={connect}
            disabled={!url || !loginWarehouse || !username || !password || connecting || savingVault}
          >
            {connecting ? <Busy label="Connecting…" /> : connected ? 'Reconnect' : 'Connect to Snowflake'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={saveCredsInVault}
            disabled={!url || !loginWarehouse || !username || !password || connecting || savingVault}
          >
            {savingVault ? <Busy label="Saving…" /> : 'Save Creds in Vault'}
          </button>
          <button type="button" className="ghost" onClick={useSavedCreds} disabled={!vaultSaved || connecting || savingVault}>
            Use Saved Creds
          </button>
          {!connected && !connectError ? (
            <span className="small muted">Opens a session so you can pick warehouse, database, schema, and tables.</span>
          ) : null}
        </div>
        {vaultNotice ? <p className="small muted" style={{ marginTop: 8 }}>{vaultNotice}</p> : null}
        {connectError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {connectError}
          </div>
        ) : null}
      </div>

      <div className={`sf-section ${connected ? '' : 'disabled'}`}>
        <div className="h">
          <span className="dot" />
          <span className="tt">Warehouse · Database · Schema</span>
          {loadingScope ? (
            <span className="small muted" style={{ marginLeft: 'auto' }}>
              <Busy label={`Loading ${loadingScope}…`} />
            </span>
          ) : null}
        </div>
        <div className="sf-grid">
          <div>
            <label>Warehouse</label>
            <select
              value={warehouse}
              onChange={(e) => {
                setWarehouse(e.target.value);
                setDatabase('');
                setSchema('');
                setTables([]);
              }}
              disabled={!connected}
            >
              <option value="">Select a warehouse…</option>
              {warehouses.map((w) => (
                <option key={w.name} value={w.name}>
                  {w.label === w.name ? w.name : `${w.label} (${w.name})`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Database</label>
            <select
              value={database}
              onChange={(e) => {
                setDatabase(e.target.value);
                setSchema('');
                setTables([]);
              }}
              disabled={!warehouse}
            >
              <option value="">Select a database…</option>
              {databases.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.label === d.name ? d.name : `${d.label} (${d.name})`}
                </option>
              ))}
            </select>
          </div>
          <div className="full">
            <label>Schema</label>
            <select
              value={schema}
              onChange={(e) => {
                setSchema(e.target.value);
                setTables([]);
              }}
              disabled={!database}
            >
              <option value="">Select a schema…</option>
              {schemas.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.label === s.name ? s.name : `${s.label} (${s.name})`}
                </option>
              ))}
            </select>
          </div>
        </div>
        {scopeReady ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            {tables.length} table{tables.length === 1 ? '' : 's'} in {database}.{schema}
          </div>
        ) : connected && schema && !loadingScope ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            No tables in {database}.{schema}. Try another schema.
          </div>
        ) : null}
      </div>

      <DataModelBuilder
        key={`${warehouse}/${database}/${schema}`}
        objects={tables}
        describe={(name) =>
          api.snowflakeDescribe(warehouse, database, schema, name).then((r) => r.fields)
        }
        onChange={setModel}
        disabled={!scopeReady}
        noun="table"
        nounPlural="tables"
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
                name="sfk-materialization"
                checked={materialization === 'extract'}
                onChange={() => setMaterialization('extract')}
              />
              Extract (bundled <code>.hyper</code>, refreshed after publish)
            </label>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="radio"
                name="sfk-materialization"
                checked={materialization === 'live'}
                onChange={() => setMaterialization('live')}
              />
              Live (Tableau queries Snowflake directly)
            </label>
          </div>
          <div className="sf-note" style={{ marginTop: 8 }}>
            {materialization === 'extract'
              ? 'Rows are queried now and materialized into an extract. After publishing, a server-side extract refresh runs on Tableau Cloud.'
              : 'No data is copied — Tableau Cloud connects to Snowflake live with the embedded username and password.'}
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
            <input placeholder="e.g. Snowflake Orders DS" value={dsName} onChange={(e) => setDsName(e.target.value)} />
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
        <button style={{ marginTop: 14, width: '100%' }} onClick={submit} disabled={!ready || busy === 'snowflake-publish'}>
          {busy === 'snowflake-publish' ? <Busy label="Publishing…" /> : 'Create & publish datasource'}
        </button>
      </div>
    </div>
  );
}
