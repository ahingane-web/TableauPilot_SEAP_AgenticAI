import React, { useMemo, useState } from 'react';
import { api } from '../api';
import type { NamedItem } from '../types';
import { Busy } from './common';
import { DataModelBuilder, type DataModel } from './DataModelBuilder';

/** One uploaded sheet's identity (returned by the upload endpoint). */
interface UploadedSheet {
  id: string;
  caption: string;
  rowCount: number;
  fields: Array<{ name: string; label: string; type: string }>;
}

/**
 * The "Build datasource" sub-flow for the Excel connector.
 *
 * The user uploads a workbook; the server parses it once (sheets + schema + rows) and returns
 * the sheet list, which we feed into the SAME {@link DataModelBuilder} the Salesforce flow uses
 * (sheets play the role of objects). Publishing materializes the selected sheets into a `.hyper`
 * and publishes an EXTRACT-ONLY datasource. On success the parent locks it and the dashboard flow
 * proceeds unchanged. No Salesforce logic is involved.
 */
export function ExcelBuild({
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
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [sheets, setSheets] = useState<UploadedSheet[]>([]);
  const uploaded = sheets.length > 0;

  const [model, setModel] = useState<DataModel>({ objects: [], relationships: [], mode: 'relationship', valid: false });
  const [projectId, setProjectId] = useState('');
  const [dsName, setDsName] = useState('');
  const [overwrite, setOverwrite] = useState(false);

  const objects = useMemo(() => sheets.map((s) => ({ name: s.id, label: s.caption })), [sheets]);
  const fieldsById = useMemo(
    () => Object.fromEntries(sheets.map((s) => [s.id, s.fields])),
    [sheets],
  ) as Record<string, UploadedSheet['fields']>;

  async function onFile(file: File): Promise<void> {
    setUploading(true);
    setUploadError(null);
    setPublishError(null);
    try {
      const res = await api.excelUpload(file);
      setFilename(res.filename);
      setSheets(res.sheets);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : 'Could not read that workbook.');
      setSheets([]);
      setFilename(null);
    } finally {
      setUploading(false);
    }
  }

  const ready = Boolean(model.valid && projectId && dsName);

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy('excel-publish');
    setPublishError(null);
    try {
      const res = await api.excelPublish({
        sheets: model.objects,
        relationships: model.relationships,
        mode: model.mode,
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
        <div className="sf-logo">XL</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">Excel data source</div>
          <div className="s">Upload a workbook, model your sheets, then publish an extract to Tableau Cloud.</div>
        </div>
      </div>

      <div className="sf-steps">
        <div className={`st ${uploaded ? 'done' : 'active'}`}>
          <span className="n">{uploaded ? '✓' : '1'}</span> Upload
        </div>
        <span className="sep" />
        <div className={`st ${model.valid ? 'done' : uploaded ? 'active' : ''}`}>
          <span className="n">{model.valid ? '✓' : '2'}</span> Model
        </div>
        <span className="sep" />
        <div className={`st ${ready ? 'active' : ''}`}>
          <span className="n">3</span> Publish
        </div>
      </div>

      {/* Step 1 — Upload */}
      <div className="sf-section">
        <div className="h">
          <span className="dot" />
          <span className="tt">Upload an Excel workbook</span>
          {uploaded ? (
            <span className="badge ok small" style={{ marginLeft: 'auto' }}>
              {sheets.length} sheet{sheets.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <div className="sf-note" style={{ marginBottom: 10 }}>
          Your workbook is parsed <strong>on the server</strong> to list its sheets and columns. The published datasource is
          an <strong>extract</strong> (the data is bundled in a <code>.hyper</code>) — no live file connection is needed on
          Tableau Cloud.
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <input
            type="file"
            accept=".xlsx,.xlsm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = ''; // allow re-selecting the same file
            }}
            disabled={uploading}
          />
          {uploading ? <Busy label="Reading…" /> : null}
          {filename && !uploading ? <span className="small muted">{filename}</span> : null}
        </div>
        {uploadError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {uploadError}
          </div>
        ) : null}
        {uploaded ? (
          <div className="small muted" style={{ marginTop: 8 }}>
            {sheets.map((s) => `${s.caption} (${s.rowCount.toLocaleString()} rows)`).join(' · ')}
          </div>
        ) : null}
      </div>

      {/* Step 2 — Model (shared with the Salesforce connector) */}
      <DataModelBuilder
        objects={objects}
        describe={(id) => Promise.resolve(fieldsById[id] ?? [])}
        onChange={setModel}
        disabled={!uploaded}
        noun="sheet"
        nounPlural="sheets"
      />

      {/* Step 3 — Publish */}
      <div className={`sf-section ${uploaded ? '' : 'disabled'}`}>
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
            <input placeholder="e.g. APAC Superstore DS" value={dsName} onChange={(e) => setDsName(e.target.value)} />
          </div>
        </div>
        <label className="checkline" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          <span>Overwrite if a datasource with this name already exists</span>
        </label>
        <div className="sf-note" style={{ marginTop: 8 }}>
          The datasource is published <strong>extract-only</strong> with its data included — it is viewable immediately and
          does not require a live connection back to the uploaded file.
        </div>
        {publishError ? (
          <div className="warnbox small" style={{ marginTop: 10 }}>
            {publishError}
          </div>
        ) : null}
        <button style={{ marginTop: 14, width: '100%' }} onClick={submit} disabled={!ready || busy === 'excel-publish'}>
          {busy === 'excel-publish' ? <Busy label="Publishing…" /> : 'Create & publish datasource'}
        </button>
      </div>
    </div>
  );
}
