import React, { useState } from 'react';
import { api } from '../api';
import type { CreationResult, PlanningResult, ReferenceLineView, SessionContext, WorksheetSpecView } from '../types';
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
  const [sizeConfirmed, setSizeConfirmed] = useState(false);
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
    setSizeConfirmed(false);
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

  /** Change workbook name and/or overwrite without re-running the AI. Re-approval required. */
  async function updatePublishing(opts: { workbookName?: string; overwrite?: boolean }): Promise<void> {
    setError(null);
    setBusy('publishing');
    try {
      const res = await api.setPublishing(opts);
      setPlanning(res);
      setApproved(false); // publishing change invalidates prior approval
      onChange(await api.context());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  /** Apply the user's chosen dashboard size (Automatic / Fixed / Range). Re-approval required. */
  async function updateSize(opts: Parameters<typeof api.setSize>[0]): Promise<void> {
    setError(null);
    setBusy('size');
    try {
      const res = await api.setSize(opts);
      setPlanning(res);
      setApproved(false); // size change invalidates prior approval
      setSizeConfirmed(true);
      onChange(await api.context());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  /** Generic "edit the plan without re-running the AI" helper. Re-approval required. */
  async function applyEdit(tag: string, run: () => Promise<PlanningResult>): Promise<void> {
    setError(null);
    setBusy(tag);
    try {
      const res = await run();
      setPlanning(res);
      setApproved(false);
      onChange(await api.context());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const updateAppearance = (o: Parameters<typeof api.setAppearance>[0]): Promise<void> =>
    applyEdit('appearance', () => api.setAppearance(o));
  const updateActions = (o: Parameters<typeof api.setActions>[0]): Promise<void> =>
    applyEdit('actions', () => api.setActions(o));
  const updateWorksheetFormat = (o: Parameters<typeof api.setWorksheetFormat>[0]): Promise<void> =>
    applyEdit('wsformat', () => api.setWorksheetFormat(o));

  /** Chat: revise the current plan from a natural-language instruction (re-runs the AI). */
  const revise = (instruction: string): Promise<void> =>
    applyEdit('revise', () => api.revisePlan(instruction));

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
          sizeConfirmed={sizeConfirmed}
          onApprove={approve}
          onExecute={execute}
          onUpdatePublishing={updatePublishing}
          onUpdateSize={updateSize}
          onUpdateAppearance={updateAppearance}
          onUpdateActions={updateActions}
          onUpdateWorksheetFormat={updateWorksheetFormat}
          onRevise={revise}
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
  sizeConfirmed,
  onApprove,
  onExecute,
  onUpdatePublishing,
  onUpdateSize,
  onUpdateAppearance,
  onUpdateActions,
  onUpdateWorksheetFormat,
  onRevise,
  busy,
}: {
  planning: PlanningResult;
  approved: boolean;
  sizeConfirmed: boolean;
  onApprove: () => void;
  onExecute: () => void;
  onUpdatePublishing: (opts: { workbookName?: string; overwrite?: boolean }) => void;
  onUpdateSize: (opts: Parameters<typeof api.setSize>[0]) => void;
  onUpdateAppearance: (opts: Parameters<typeof api.setAppearance>[0]) => void;
  onUpdateActions: (opts: Parameters<typeof api.setActions>[0]) => void;
  onUpdateWorksheetFormat: (opts: Parameters<typeof api.setWorksheetFormat>[0]) => void;
  onRevise: (instruction: string) => void;
  busy: string | null;
}): React.ReactElement {
  const { plan, validation, nameConflict } = planning;
  const overwrite = Boolean(plan.publishing.overwrite);
  const [renameTo, setRenameTo] = useState(plan.publishing.workbookName);
  // The user must resolve a name conflict (overwrite or rename) before approving.
  const blockedByConflict = nameConflict && !overwrite;
  // The user must explicitly confirm a dashboard size before approving.
  const blockedBySize = !sizeConfirmed;
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

      <ReviseChat busy={busy === 'revise'} onSend={onRevise} />

      <BoardHierarchy
        plan={plan}
        busy={busy}
        dims={validation.availableDimensions}
        measures={validation.availableMeasures}
        onUpdateWorksheetFormat={onUpdateWorksheetFormat}
      />

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
        <div className="k">On name clash</div>
        <div>{overwrite ? 'Overwrite the existing workbook' : 'Do not overwrite'}</div>
      </div>

      <div style={{ marginTop: 10 }}>
        <label>Workbook name</label>
        <div className="row">
          <input
            placeholder="Name for the published workbook"
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
          />
          <button
            className="ghost"
            onClick={() => onUpdatePublishing({ workbookName: renameTo.trim() })}
            disabled={busy === 'publishing' || !renameTo.trim() || renameTo.trim() === plan.publishing.workbookName}
          >
            {busy === 'publishing' ? <Busy label="Checking…" /> : 'Use this name'}
          </button>
        </div>
        <p className="small muted" style={{ marginTop: 4 }}>
          Publishing as “{plan.publishing.workbookName}”. Change the name above and click “Use this name” to re-check.
        </p>
      </div>

      {nameConflict ? (
        <div className="warnbox" style={{ marginTop: 10 }}>
          <strong>A workbook named “{plan.publishing.workbookName}” already exists in “{plan.publishing.projectName}”.</strong>
          <p className="small">Overwrite it, or change the workbook name above and click “Use this name”.</p>
          <div className="row">
            <button
              className={overwrite ? undefined : 'danger'}
              onClick={() => onUpdatePublishing({ overwrite: true })}
              disabled={overwrite || busy === 'publishing'}
            >
              {busy === 'publishing' ? <Busy label="Updating…" /> : overwrite ? 'Overwrite selected ✓' : 'Overwrite existing'}
            </button>
            {overwrite ? (
              <button className="ghost" onClick={() => onUpdatePublishing({ overwrite: false })} disabled={busy === 'publishing'}>
                Don’t overwrite
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <SizeChooser
        plan={plan}
        confirmed={sizeConfirmed}
        busy={busy === 'size'}
        onApply={onUpdateSize}
      />

      <AppearanceChooser plan={plan} busy={busy === 'appearance'} onApply={onUpdateAppearance} />
      <InteractivityChooser plan={plan} busy={busy === 'actions'} onApply={onUpdateActions} />

      <div className="row" style={{ marginTop: 12 }}>
        {!approved ? (
          <button
            onClick={onApprove}
            disabled={!validation.valid || blockedByConflict || blockedBySize || busy === 'approve'}
          >
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
      {blockedByConflict ? (
        <p className="hint">Resolve the name clash above (overwrite or rename) before approving.</p>
      ) : null}
      {blockedBySize ? (
        <p className="hint">Choose a dashboard size above (Automatic, Fixed, or Range) before approving.</p>
      ) : null}
      <p className="hint">Publishing is guarded: it goes only to the approved project, and success is confirmed by verification.</p>
    </div>
  );
}

/**
 * Dashboard size chooser — the app ALWAYS asks the user to pick a size before publishing.
 * Automatic (fits the window), Fixed (exact WxH), or Range (scales between min/max WxH).
 */
function SizeChooser({
  plan,
  confirmed,
  busy,
  onApply,
}: {
  plan: PlanningResult['plan'];
  confirmed: boolean;
  busy: boolean;
  onApply: (opts: Parameters<typeof api.setSize>[0]) => void;
}): React.ReactElement {
  const [mode, setMode] = useState<'automatic' | 'fixed' | 'range'>(plan.layout.size ?? 'fixed');
  const [width, setWidth] = useState(plan.layout.width || 1200);
  const [height, setHeight] = useState(plan.layout.height || 800);
  const [minWidth, setMinWidth] = useState(plan.layout.minWidth ?? 800);
  const [minHeight, setMinHeight] = useState(plan.layout.minHeight ?? 600);
  const [maxWidth, setMaxWidth] = useState(plan.layout.maxWidth ?? 1400);
  const [maxHeight, setMaxHeight] = useState(plan.layout.maxHeight ?? 900);

  const apply = (): void => {
    if (mode === 'automatic') onApply({ size: 'automatic' });
    else if (mode === 'fixed') onApply({ size: 'fixed', width, height });
    else onApply({ size: 'range', minWidth, minHeight, maxWidth, maxHeight });
  };

  const num = (v: number, set: (n: number) => void): React.ReactElement => (
    <input
      type="number"
      min={1}
      value={v}
      style={{ width: 90 }}
      onChange={(e) => set(Math.max(1, Number(e.target.value) || 0))}
    />
  );

  return (
    <div className="warnbox" style={{ marginTop: 12 }}>
      <strong>Dashboard size {confirmed ? <span className="badge ok">chosen ✓</span> : '(required)'}</strong>
      <p className="small muted" style={{ marginTop: 4 }}>
        How should the dashboard size behave in Tableau?
      </p>
      <div className="row" style={{ gap: 12 }}>
        {(['automatic', 'fixed', 'range'] as const).map((m) => (
          <label key={m} className="small" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="radio" name="dash-size" checked={mode === m} onChange={() => setMode(m)} />
            {m === 'automatic' ? 'Automatic' : m === 'fixed' ? 'Fixed' : 'Range'}
          </label>
        ))}
      </div>

      {mode === 'fixed' ? (
        <div className="row small" style={{ marginTop: 6, gap: 6, alignItems: 'center' }}>
          W {num(width, setWidth)} × H {num(height, setHeight)} px
        </div>
      ) : null}
      {mode === 'range' ? (
        <div className="small" style={{ marginTop: 6 }}>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            Min W {num(minWidth, setMinWidth)} × H {num(minHeight, setMinHeight)}
          </div>
          <div className="row" style={{ gap: 6, alignItems: 'center', marginTop: 4 }}>
            Max W {num(maxWidth, setMaxWidth)} × H {num(maxHeight, setMaxHeight)}
          </div>
        </div>
      ) : null}
      {mode === 'automatic' ? (
        <p className="small muted" style={{ marginTop: 6 }}>The dashboard resizes to fit the browser window.</p>
      ) : null}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={apply} disabled={busy}>
          {busy ? <Busy label="Applying…" /> : confirmed ? 'Update size' : 'Use this size'}
        </button>
      </div>
    </div>
  );
}

const FONT_CHOICES = ['Tableau Bold', 'Tableau Book', 'Tableau Medium', 'Arial', 'Georgia', 'Times New Roman'];

/** Dashboard theme: background + container colors and the title font. */
function AppearanceChooser({
  plan,
  busy,
  onApply,
}: {
  plan: PlanningResult['plan'];
  busy: boolean;
  onApply: (opts: Parameters<typeof api.setAppearance>[0]) => void;
}): React.ReactElement {
  const tf = plan.layout.titleFormat;
  const [bg, setBg] = useState(plan.layout.backgroundColor ?? '#e6e6e6');
  const [container, setContainer] = useState(plan.layout.containerBackground ?? '#ffffff');
  const [fontName, setFontName] = useState(tf?.fontName ?? 'Tableau Bold');
  const [fontSize, setFontSize] = useState(tf?.fontSize ?? 16);
  const [fontColor, setFontColor] = useState(tf?.fontColor ?? '#1b1b1b');

  const apply = (): void =>
    onApply({ backgroundColor: bg, containerBackground: container, titleFormat: { fontName, fontSize, fontColor, bold: true } });

  return (
    <div className="warnbox" style={{ marginTop: 12 }}>
      <strong>Dashboard theme</strong>
      <div className="row small" style={{ gap: 12, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Background <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Containers <input type="color" value={container} onChange={(e) => setContainer(e.target.value)} />
        </label>
      </div>
      <div className="row small" style={{ gap: 12, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Title color <input type="color" value={fontColor} onChange={(e) => setFontColor(e.target.value)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Title size
          <input
            type="number"
            min={8}
            max={48}
            value={fontSize}
            style={{ width: 70 }}
            onChange={(e) => setFontSize(Math.min(48, Math.max(8, Number(e.target.value) || 16)))}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Font
          <select value={fontName} onChange={(e) => setFontName(e.target.value)}>
            {FONT_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={apply} disabled={busy}>
          {busy ? <Busy label="Applying…" /> : 'Apply theme'}
        </button>
      </div>
    </div>
  );
}

/** Dashboard interactivity: the "use marks as filter" action. */
function InteractivityChooser({
  plan,
  busy,
  onApply,
}: {
  plan: PlanningResult['plan'];
  busy: boolean;
  onApply: (opts: Parameters<typeof api.setActions>[0]) => void;
}): React.ReactElement {
  const filterAction = (plan.actions ?? []).find((a) => a.type === 'filter');
  const explicitlyOff = (plan.actions ?? []).some((a) => a.type === 'none');
  const [enabled, setEnabled] = useState(!explicitlyOff); // interactive by default
  const [runOn, setRunOn] = useState<'select' | 'hover' | 'menu'>(filterAction?.runOn ?? 'select');

  return (
    <div className="warnbox" style={{ marginTop: 12 }}>
      <strong>Interactivity</strong>
      <div className="row small" style={{ gap: 12, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Use marks as filter (click a chart to filter the rest)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          On
          <select value={runOn} disabled={!enabled} onChange={(e) => setRunOn(e.target.value as 'select' | 'hover' | 'menu')}>
            <option value="select">select</option>
            <option value="hover">hover</option>
            <option value="menu">menu</option>
          </select>
        </label>
      </div>
      <p className="small muted" style={{ marginTop: 4 }}>KPI cards are automatically excluded as filter sources.</p>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={() => onApply({ enabled, runOn })} disabled={busy}>
          {busy ? <Busy label="Applying…" /> : 'Apply interactivity'}
        </button>
      </div>
    </div>
  );
}

/**
 * Chat box that revises the plan from a natural-language instruction. The AI re-plans
 * (adding filters, changing charts, splitting into multiple dashboards, …) and the user
 * re-approves the result. Cmd/Ctrl+Enter sends.
 */
function ReviseChat({ busy, onSend }: { busy: boolean; onSend: (instruction: string) => void }): React.ReactElement {
  const [text, setText] = useState('');
  const send = (): void => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="warnbox" style={{ marginTop: 10 }}>
      <strong>Refine with chat</strong>
      <p className="small muted" style={{ marginTop: 4 }}>
        Describe a change and the AI revises this plan (e.g. “add a Region filter”, “split
        into a Sales and a Customer dashboard”, “make the trend a line chart”). You’ll
        re-approve afterwards.
      </p>
      <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
        <textarea
          placeholder="e.g. Add a monthly sales trend and put customer charts on a separate dashboard"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1, minHeight: 44 }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
          }}
        />
        <button onClick={send} disabled={busy || !text.trim()}>
          {busy ? <Busy label="Revising…" /> : 'Send'}
        </button>
      </div>
    </div>
  );
}

/**
 * Hierarchical plan view: each DASHBOARD (board) is a group, with its worksheets nested
 * beneath it. Each worksheet is collapsible (show/hide its detail + formatting). A single
 * dashboard renders one group; a multi-dashboard plan renders one group per board (tab).
 */
function BoardHierarchy({
  plan,
  busy,
  dims,
  measures,
  onUpdateWorksheetFormat,
}: {
  plan: PlanningResult['plan'];
  busy: string | null;
  dims: string[];
  measures: string[];
  onUpdateWorksheetFormat: (opts: Parameters<typeof api.setWorksheetFormat>[0]) => void;
}): React.ReactElement {
  const byName = new Map(plan.worksheets.map((w) => [w.name, w] as const));
  const boards =
    plan.dashboards && plan.dashboards.length > 0
      ? plan.dashboards
      : [{ name: plan.dashboardName, title: plan.layout.title, items: plan.layout.items }];

  const placed = new Set<string>();
  for (const b of boards) for (const it of b.items ?? []) placed.add(it.worksheet);
  const unplaced = plan.worksheets.filter((w) => !placed.has(w.name));
  const multi = boards.length > 1;

  return (
    <div style={{ marginTop: 8 }}>
      {multi ? (
        <div className="small muted" style={{ marginBottom: 6 }}>
          {boards.length} dashboards in this workbook — one tab each.
        </div>
      ) : null}
      {boards.map((board, bi) => {
        const sheets = (board.items ?? [])
          .map((it) => byName.get(it.worksheet))
          .filter((w): w is WorksheetSpecView => Boolean(w));
        const extras = bi === 0 ? unplaced : [];
        const all = [...sheets, ...extras];
        return (
          <div
            className="board"
            key={`${board.name}-${bi}`}
            style={{ border: '1px solid #2a2a2a', borderRadius: 8, padding: 10, marginBottom: 10 }}
          >
            <div className="title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden style={{ fontSize: 16 }}>🗂️</span>
              <strong>{board.title || board.name}</strong>
              <span className="badge">
                {all.length} sheet{all.length === 1 ? '' : 's'}
              </span>
            </div>
            <div style={{ marginTop: 8, marginLeft: 8, borderLeft: '2px solid #333', paddingLeft: 10 }}>
              {all.map((ws) => (
                <WorksheetNode key={ws.name} ws={ws} busy={busy} dims={dims} measures={measures} onApply={onUpdateWorksheetFormat} />
              ))}
              {all.length === 0 ? <div className="small muted">No worksheets on this dashboard.</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One worksheet row inside a board: collapsible (show/hide) with its detail + formatting. */
function WorksheetNode({
  ws,
  busy,
  dims,
  measures,
  onApply,
}: {
  ws: WorksheetSpecView;
  busy: string | null;
  dims: string[];
  measures: string[];
  onApply: (opts: Parameters<typeof api.setWorksheetFormat>[0]) => void;
}): React.ReactElement {
  return (
    <details className="worksheet" style={{ marginTop: 6 }}>
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{ws.name}</strong>
        <span className="chartchip">{ws.chartType}</span>
      </summary>
      <div className="small muted" style={{ marginTop: 4 }}>
        {ws.dimensions.length ? `Dimensions: ${ws.dimensions.join(', ')}. ` : ''}
        {ws.measures.length ? `Measures: ${ws.measures.map((m) => `${m.aggregation}(${m.field})`).join(', ')}.` : ''}
        {ws.kpiMeasure ? `KPI: ${ws.kpiMeasure.aggregation}(${ws.kpiMeasure.field}).` : ''}
      </div>
      <WorksheetFormatControls ws={ws} busy={busy === 'wsformat'} dims={dims} measures={measures} onApply={onApply} />
    </details>
  );
}

/** Per-worksheet formatting: value labels, grand totals, a reference line, color palette. */
function WorksheetFormatControls({
  ws,
  busy,
  dims,
  measures,
  onApply,
}: {
  ws: WorksheetSpecView;
  busy: boolean;
  dims: string[];
  measures: string[];
  onApply: (opts: Parameters<typeof api.setWorksheetFormat>[0]) => void;
}): React.ReactElement | null {
  const isKpi = ws.chartType === 'kpi';
  const measureNames = ws.measures.map((m) => m.field);
  const existingRl = ws.referenceLines?.[0];

  const [showLabels, setShowLabels] = useState<boolean>(ws.formatting?.showLabels ?? false);
  const [gtRow, setGtRow] = useState<boolean>(ws.grandTotals?.row ?? false);
  const [gtCol, setGtCol] = useState<boolean>(ws.grandTotals?.column ?? false);
  const [rlOn, setRlOn] = useState<boolean>(Boolean(existingRl));
  const [rlField, setRlField] = useState<string>(existingRl?.field ?? measureNames[0] ?? '');
  const [rlFormula, setRlFormula] = useState<ReferenceLineView['formula']>(existingRl?.formula ?? 'average');
  const [rlValue, setRlValue] = useState<number>(existingRl?.value ?? 0);
  const [colorField, setColorField] = useState<string>(ws.colorMap?.field ?? ws.dimensions[0] ?? '');
  const [colorRows, setColorRows] = useState<{ value: string; color: string }[]>(ws.colorMap?.colors ?? []);
  // Color-mark field: default to the current selection, else the first dimension.
  const [colorMarkField, setColorMarkField] = useState<string>(ws.formatting?.colorField ?? dims[0] ?? '');

  // KPI cards only support a headline value; the chart-level controls don't apply.
  if (isKpi) return null;

  const setRow = (i: number, patch: Partial<{ value: string; color: string }>): void =>
    setColorRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const apply = (): void => {
    const opts: Parameters<typeof api.setWorksheetFormat>[0] = { name: ws.name, showLabels };
    opts.grandTotals = gtRow || gtCol ? { row: gtRow, column: gtCol } : null;
    opts.referenceLines =
      rlOn && rlField
        ? [
            {
              field: rlField,
              aggregation: 'sum',
              formula: rlFormula,
              ...(rlFormula === 'constant' ? { value: rlValue } : {}),
              scope: 'per-pane',
              labelType: 'automatic',
            },
          ]
        : [];
    const cleanColors = colorRows.filter((r) => r.value.trim() && /^#[0-9a-fA-F]{6}$/.test(r.color));
    opts.colorMap = colorField && cleanColors.length ? { field: colorField, colors: cleanColors } : null;
    opts.colorField = colorMarkField || '';
    onApply(opts);
  };

  const isMeasureColor = measures.includes(colorMarkField);

  return (
    <details style={{ marginTop: 6 }}>
      <summary className="small" style={{ cursor: 'pointer' }}>Formatting</summary>
      <div style={{ marginTop: 6 }}>
        <div className="row small" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <span>Color by</span>
          <select value={colorMarkField} onChange={(e) => setColorMarkField(e.target.value)}>
            <option value="">(chart default)</option>
            {dims.length ? (
              <optgroup label="Dimensions">
                {dims.map((d) => (
                  <option key={`d-${d}`} value={d}>
                    {d}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {measures.length ? (
              <optgroup label="Measures">
                {measures.map((m) => (
                  <option key={`m-${m}`} value={m}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <span className="muted">{colorMarkField ? (isMeasureColor ? '(continuous)' : '(by category)') : ''}</span>
        </div>
        <div className="row small" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Value labels
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={gtRow} onChange={(e) => setGtRow(e.target.checked)} /> Grand total (row)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={gtCol} onChange={(e) => setGtCol(e.target.checked)} /> Grand total (column)
          </label>
        </div>

        {measureNames.length ? (
          <div className="row small" style={{ gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={rlOn} onChange={(e) => setRlOn(e.target.checked)} /> Reference line
            </label>
            <select value={rlField} disabled={!rlOn} onChange={(e) => setRlField(e.target.value)}>
              {measureNames.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select value={rlFormula} disabled={!rlOn} onChange={(e) => setRlFormula(e.target.value as ReferenceLineView['formula'])}>
              {(['average', 'median', 'sum', 'min', 'max', 'total', 'constant'] as const).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            {rlFormula === 'constant' ? (
              <input
                type="number"
                value={rlValue}
                disabled={!rlOn}
                style={{ width: 100 }}
                onChange={(e) => setRlValue(Number(e.target.value) || 0)}
              />
            ) : null}
          </div>
        ) : null}

        {ws.dimensions.length ? (
          <div className="small" style={{ marginTop: 6 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>Colors for</span>
              <select value={colorField} onChange={(e) => setColorField(e.target.value)}>
                {ws.dimensions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            {colorRows.map((r, i) => (
              <div className="row" key={i} style={{ gap: 6, alignItems: 'center', marginTop: 4 }}>
                <input
                  placeholder="member value (e.g. Furniture)"
                  value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                />
                <input type="color" value={r.color} onChange={(e) => setRow(i, { color: e.target.value })} />
                <button className="ghost" onClick={() => setColorRows((rows) => rows.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="ghost" style={{ marginTop: 4 }} onClick={() => setColorRows((rows) => [...rows, { value: '', color: '#4e79a7' }])}>
              + color
            </button>
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 8 }}>
          <button className="ghost" onClick={apply} disabled={busy}>
            {busy ? <Busy label="Applying…" /> : 'Apply formatting'}
          </button>
        </div>
      </div>
    </details>
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
