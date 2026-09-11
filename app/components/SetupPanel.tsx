import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { DatasourceMetadataView, NamedItem, SessionContext } from '../types';
import { Busy, ErrorPanel } from './common';

/**
 * Connect + select destination project + select and LOCK the datasource.
 * The datasource lock is the single source of truth; changing it requires an
 * explicit confirmation (change guard).
 */
export function SetupPanel({ ctx, onChange }: { ctx: SessionContext; onChange: (ctx: SessionContext) => void }): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [projects, setProjects] = useState<NamedItem[]>([]);
  const [datasources, setDatasources] = useState<NamedItem[]>([]);
  const [selDs, setSelDs] = useState('');
  const [metadata, setMetadata] = useState<DatasourceMetadataView | null>(null);
  const [confirmChange, setConfirmChange] = useState(false);

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

  async function unlock(): Promise<void> {
    setBusy('unlock');
    setError(null);
    try {
      await api.unlockDatasource();
      setMetadata(null);
      setSelDs('');
      setConfirmChange(false);
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
            <label>Published datasource (source of truth)</label>
            {ctx.datasourceLock ? (
              <div className="lock">
                <span className="locked">🔒 Locked:</span>
                <span>{ctx.datasourceLock.datasourceName}</span>
                <button className="ghost" onClick={() => setConfirmChange(true)} disabled={ctx.hasPlan}>
                  Change…
                </button>
              </div>
            ) : (
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
              <FieldPills title="Dimensions" cls="dim" fields={metadata.dimensions.map((f) => f.name)} />
              <FieldPills title="Measures" cls="mea" fields={metadata.measures.map((f) => f.name)} />
              <FieldPills title="Dates" cls="date" fields={metadata.dates.map((f) => f.name)} />
            </div>
          ) : null}
        </div>
      )}

      <ErrorPanel error={error} onDismiss={() => setError(null)} />

      {confirmChange ? (
        <div className="warnbox" style={{ marginTop: 10 }}>
          <strong>Change the locked datasource?</strong>
          <p className="small">
            The datasource is the single source of truth for your dashboard. Changing it will clear the current plan.
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
