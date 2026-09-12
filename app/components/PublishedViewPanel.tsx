import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EmbedInfo, SessionContext } from '../types';
import { Busy } from './common';

/**
 * READ-ONLY published dashboard viewer.
 *
 * Web Authoring (editing) has been removed. This is a single LIVE viewer: the
 * Embedding API v3 `<tableau-viz>` loads the published dashboard VIEW-ONLY with the
 * toolbar hidden (URL `#/site/<site>/views/<workbook>/<sheet>?:embed=yes&:toolbar=no`),
 * so the user can only SEE the dashboard inside our UI — never edit it. The exact
 * view-only URL is shown in the header so it can be verified/copied.
 */
const scriptPromises = new Map<string, Promise<void>>();

function loadEmbeddingScript(url: string): Promise<void> {
  if (scriptPromises.has(url)) return scriptPromises.get(url)!;
  const p = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[data-tableau-embed="${url}"]`);
    if (existing) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.type = 'module';
    s.src = url;
    s.dataset.tableauEmbed = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load the Tableau Embedding API from the pod.'));
    document.head.appendChild(s);
  });
  scriptPromises.set(url, p);
  return p;
}

export function PublishedViewPanel({ ctx }: { ctx: SessionContext }): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<EmbedInfo | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'no-src' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [revising, setRevising] = useState(false);

  const hasWorkbook = Boolean(ctx.workbook);

  async function open(): Promise<void> {
    setError(null);
    setStatus('loading');
    try {
      const embed = await api.embedInfo();
      setInfo(embed);
      if (!embed.src) {
        setStatus('no-src');
        return;
      }
      await loadEmbeddingScript(embed.embeddingLibraryUrl);
      renderViz(embed);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  /**
   * Chat: modify the ALREADY-PUBLISHED dashboard. The AI revises the plan and the server
   * republishes it in place (overwrite), then we reload the live viewer to show the result.
   */
  async function modify(): Promise<void> {
    const ask = instruction.trim();
    if (!ask) return;
    setError(null);
    setRevising(true);
    try {
      await api.revisePublished(ask);
      setInstruction('');
      await open(); // reload the embed to reflect the republished workbook
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    } finally {
      setRevising(false);
    }
  }

  function renderViz(embed: EmbedInfo): void {
    const container = containerRef.current;
    if (!container || !embed.src) return;
    container.innerHTML = '';
    // `<tableau-viz>` is the READ-ONLY viewer (never the authoring viz): toolbar hidden and
    // no edit affordance, so the user can only VIEW the published dashboard.
    const viz = document.createElement('tableau-viz') as HTMLElement & Record<string, unknown>;
    viz.setAttribute('src', embed.src);
    if (embed.token) viz.setAttribute('token', embed.token);
    viz.setAttribute('toolbar', 'hidden');
    viz.style.width = '100%';
    viz.style.height = '100%';
    // Keep a usable minimum so a fixed-size dashboard isn't crushed into the pane and
    // clipped: when the preview pane is smaller than this, `.embed-body` scrolls so the
    // whole dashboard stays reachable. Widening the pane (drag splitter) removes the scroll.
    viz.style.minWidth = '760px';
    viz.style.minHeight = '640px';
    container.appendChild(viz);
  }

  // Auto-load the live dashboard on mount. The parent remounts this panel (via `key`)
  // whenever the workbook changes, so a mount-time load always reflects the latest one.
  useEffect(() => {
    if (hasWorkbook) void open();
    return () => {
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, []);

  return (
    <>
      <div className="embed-header">
        <strong style={{ color: 'var(--text)' }}>Published dashboard</strong>
        {info ? (
          info.requiresInteractiveLogin ? (
            <span className="badge warn">interactive login</span>
          ) : info.token ? (
            <span className="badge ok">connected app</span>
          ) : null
        ) : null}
        <div className="spacer" style={{ flex: 1 }} />
        {info?.src ? (
          <a href={info.src} target="_blank" rel="noreferrer" className="small" style={{ marginRight: 8 }}>
            Open in new tab ↗
          </a>
        ) : null}
        {hasWorkbook ? (
          <button className="secondary" onClick={open} disabled={status === 'loading' || revising}>
            {status === 'loading' ? <Busy label="Opening…" /> : 'Reload'}
          </button>
        ) : null}
      </div>

      {info?.src ? (
        <div className="embed-header" style={{ gap: 6, alignItems: 'center' }}>
          <span className="small muted" style={{ whiteSpace: 'nowrap' }}>View‑only URL</span>
          <span className="badge ok" title="Toolbar hidden, no editing — view only">read‑only</span>
          <input
            readOnly
            value={info.src}
            onFocus={(e) => e.currentTarget.select()}
            className="small"
            style={{ flex: 1, fontFamily: 'monospace' }}
            title={info.src}
          />
          <button
            className="secondary"
            onClick={() => {
              if (info.src) void navigator.clipboard?.writeText(info.src);
            }}
          >
            Copy
          </button>
        </div>
      ) : null}

      {hasWorkbook ? (
        <div className="embed-header" style={{ gap: 6 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Modify this dashboard — e.g. add a Category filter, or make the trend a line chart"
            value={instruction}
            disabled={revising}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void modify();
            }}
          />
          <button onClick={() => void modify()} disabled={revising || !instruction.trim()}>
            {revising ? <Busy label="Applying…" /> : 'Apply change'}
          </button>
        </div>
      ) : null}

      <div className="embed-body">
        {!hasWorkbook ? (
          <div className="embed-empty">
            <p>Create &amp; publish a dashboard to view it here (read-only).</p>
          </div>
        ) : (
          <>
            {status !== 'ready' ? (
              <div className="embed-empty">
                {error ? (
                  <div className="error">{error}</div>
                ) : status === 'no-src' ? (
                  <div>Could not resolve a view URL yet. Try Reload once the workbook is fully published.</div>
                ) : (
                  <Busy label="Opening dashboard…" />
                )}
              </div>
            ) : null}
            <div
              ref={containerRef}
              style={{ width: '100%', height: '100%', display: status === 'ready' ? 'block' : 'none' }}
            />
          </>
        )}
      </div>
    </>
  );
}
