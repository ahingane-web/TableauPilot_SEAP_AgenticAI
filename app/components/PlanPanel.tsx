import React, { useState } from 'react';
import { api } from '../api';
import type { CreationResult, PlanningResult, SessionContext } from '../types';
import { Busy, ErrorPanel } from './common';

/**
 * Natural-language request -> plan preview -> human approval -> execute -> verify.
 * Nothing is published until the user explicitly approves the exact plan.
 */
export function PlanPanel({
  ctx,
  onChange,
  onCreated,
}: {
  ctx: SessionContext;
  onChange: (ctx: SessionContext) => void;
  onCreated: (r: CreationResult) => void;
}): React.ReactElement {
  const [request, setRequest] = useState('');
  const [planning, setPlanning] = useState<PlanningResult | null>(null);
  const [approved, setApproved] = useState(false);
  const [result, setResult] = useState<CreationResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const ready = ctx.connected && ctx.projectContext && ctx.datasourceLock;

  async function generate(): Promise<void> {
    if (!request.trim()) return;
    setError(null);
    setBusy('plan');
    setPlanning(null);
    setApproved(false);
    setResult(null);
    try {
      const res = await api.plan(request.trim());
      setPlanning(res);
      onChange(await api.context());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function approve(): Promise<void> {
    if (!planning) return;
    setError(null);
    setBusy('approve');
    try {
      await api.approve(planning.planHash);
      setApproved(true);
      onChange(await api.context());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function execute(): Promise<void> {
    setError(null);
    setBusy('execute');
    try {
      const r = await api.execute();
      setResult(r);
      onChange(await api.context());
      onCreated(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>Describe your dashboard</h2>
      {!ready ? (
        <p className="hint">Connect, select a target project, and lock a datasource first.</p>
      ) : (
        <>
          <textarea
            placeholder="e.g. A sales overview: KPIs for total Sales and Profit, monthly sales trend, sales by Region, top 10 products by Sales, with a Category filter."
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={generate} disabled={busy === 'plan' || !request.trim()}>
              {busy === 'plan' ? <Busy label="Planning…" /> : 'Generate plan'}
            </button>
          </div>
        </>
      )}

      <ErrorPanel error={error} onDismiss={() => setError(null)} />

      {planning ? (
        <PlanPreview
          planning={planning}
          approved={approved}
          onApprove={approve}
          onExecute={execute}
          busy={busy}
        />
      ) : null}

      {result ? <VerificationResult result={result} /> : null}
    </div>
  );
}

function PlanPreview({
  planning,
  approved,
  onApprove,
  onExecute,
  busy,
}: {
  planning: PlanningResult;
  approved: boolean;
  onApprove: () => void;
  onExecute: () => void;
  busy: string | null;
}): React.ReactElement {
  const { plan, validation } = planning;
  return (
    <div style={{ marginTop: 12 }}>
      <h3>{plan.dashboardName}</h3>
      {plan.description ? <p className="small muted">{plan.description}</p> : null}

      {!validation.valid ? (
        <div className="error" style={{ marginBottom: 10 }}>
          <div className="code">FIELD ERRORS</div>
          <ul style={{ margin: '6px 0 0 16px' }}>
            {validation.errors.map((e, i) => (
              <li key={i} className="small">
                <span className="mono">{e.field}</span> — {e.message} <span className="muted">({e.location})</span>
              </li>
            ))}
          </ul>
          <div className="hint">Available measures: {validation.availableMeasures.join(', ') || '(none)'}</div>
          <div className="hint">Available dimensions: {validation.availableDimensions.join(', ') || '(none)'}</div>
        </div>
      ) : (
        <div className="success" style={{ marginBottom: 10 }}>
          All referenced fields exist in the datasource.
        </div>
      )}

      {plan.worksheets.map((ws) => (
        <div className="worksheet" key={ws.name}>
          <div className="title">
            <strong>{ws.name}</strong>
            <span className="chartchip">{ws.chartType}</span>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {ws.dimensions.length ? `Dimensions: ${ws.dimensions.join(', ')}. ` : ''}
            {ws.measures.length ? `Measures: ${ws.measures.map((m) => `${m.aggregation}(${m.field})`).join(', ')}.` : ''}
            {ws.kpiMeasure ? `KPI: ${ws.kpiMeasure.aggregation}(${ws.kpiMeasure.field}).` : ''}
          </div>
        </div>
      ))}

      {plan.filters.length ? (
        <div className="small muted">Filters: {plan.filters.map((f) => `${f.field} ${f.operator}`).join(', ')}</div>
      ) : null}
      {plan.calculatedFields.length ? (
        <div className="small muted">
          Calculated fields: {plan.calculatedFields.map((c) => `${c.name} = ${c.formula}`).join('; ')}
        </div>
      ) : null}

      <div className="kv" style={{ marginTop: 10 }}>
        <div className="k">Target project</div>
        <div>{plan.publishing.projectName}</div>
        <div className="k">Workbook name</div>
        <div>{plan.publishing.workbookName}</div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        {!approved ? (
          <button onClick={onApprove} disabled={!validation.valid || busy === 'approve'}>
            {busy === 'approve' ? <Busy label="Approving…" /> : 'Approve plan'}
          </button>
        ) : (
          <>
            <span className="badge ok">Approved</span>
            <button onClick={onExecute} disabled={busy === 'execute'}>
              {busy === 'execute' ? <Busy label="Creating & publishing…" /> : 'Create & publish to Tableau Cloud'}
            </button>
          </>
        )}
      </div>
      <p className="hint">Publishing is guarded: it goes only to the approved project, and success is confirmed by verification.</p>
    </div>
  );
}

function VerificationResult({ result }: { result: CreationResult }): React.ReactElement {
  return (
    <div className="success" style={{ marginTop: 12 }}>
      <strong>Verified in Tableau Cloud ✓</strong>
      <div className="kv" style={{ marginTop: 8 }}>
        <div className="k">Workbook</div>
        <div>{result.workbookName}</div>
        <div className="k">Project</div>
        <div>{result.projectName}</div>
        <div className="k">Views</div>
        <div>{result.viewCount}</div>
        <div className="k">Datasource</div>
        <div>{result.datasourceName}</div>
      </div>
      {result.url ? (
        <div style={{ marginTop: 8 }}>
          <a href={result.url} target="_blank" rel="noreferrer">
            Open the real dashboard in Tableau Cloud →
          </a>
        </div>
      ) : (
        <div className="hint">Workbook verified, but no direct URL was returned by Tableau.</div>
      )}
    </div>
  );
}
