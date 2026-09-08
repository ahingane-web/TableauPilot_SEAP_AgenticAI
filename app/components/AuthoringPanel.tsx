import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { EmbedInfo, SessionContext } from '../types';
import { Busy } from './common';

/**
 * Real Tableau Cloud Web Authoring embed (Embedding API v3 `TableauAuthoringViz`).
 *
 * This is NOT a fake editor: it loads the genuine Tableau authoring UI for the
 * created workbook (or a new workbook on the locked datasource) inside an iframe.
 * A Connected App JWT (minted server-side) authenticates it seamlessly; without one
 * the iframe shows Tableau's own interactive login. We listen for the real lifecycle
 * events (workbook published / published-as / ready-to-close).
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

export function AuthoringPanel({ ctx }: { ctx: SessionContext }): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [info, setInfo] = useState<EmbedInfo | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);

  const mode: 'existing_workbook' | 'new_workbook' = ctx.workbook ? 'existing_workbook' : 'new_workbook';
  const canEmbed = Boolean(ctx.workbook) || Boolean(ctx.datasourceLock);

  async function openAuthoring(): Promise<void> {
    setError(null);
    setStatus('loading');
    try {
      const embed = await api.embedInfo(mode);
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

  function renderViz(embed: EmbedInfo): void {
    const container = containerRef.current;
    if (!container || !embed.src) return;
    container.innerHTML = '';
    const viz = document.createElement('tableau-authoring-viz') as HTMLElement & Record<string, unknown>;
    viz.setAttribute('src', embed.src);
    if (embed.token) viz.setAttribute('token', embed.token);
    viz.style.width = '100%';
    viz.style.height = '100%';
    const push = (label: string) => setEvents((prev) => [`${new Date().toLocaleTimeString()} — ${label}`, ...prev].slice(0, 8));
    viz.addEventListener('firstinteractive', () => push('Authoring ready (first interactive)'));
    viz.addEventListener('workbookpublished', () => push('WorkbookPublished'));
    viz.addEventListener('workbookpublishedas', () => push('WorkbookPublishedAs'));
    viz.addEventListener('workbookreadytoclose', () => push('WorkbookReadyToClose'));
    container.appendChild(viz);
  }

  useEffect(() => {
    // Reset the embed if the workbook/lock context changes.
    setInfo(null);
    setStatus('idle');
    setEvents([]);
    if (containerRef.current) containerRef.current.innerHTML = '';
  }, [ctx.workbook?.workbookId, ctx.datasourceLock?.datasourceId]);

  return (
    <>
      <div className="embed-header">
        <strong style={{ color: 'var(--text)' }}>Real Tableau Web Authoring</strong>
        {info?.requiresInteractiveLogin ? <span className="badge warn">interactive login</span> : info?.token ? <span className="badge ok">connected app</span> : null}
        <div className="spacer" style={{ flex: 1 }} />
        {canEmbed ? (
          <button className="secondary" onClick={openAuthoring} disabled={status === 'loading'}>
            {status === 'loading' ? <Busy label="Opening…" /> : ctx.workbook ? 'Open published workbook' : 'Author on locked datasource'}
          </button>
        ) : null}
      </div>
      <div className="embed-body">
        {status === 'idle' || status === 'no-src' || status === 'error' ? (
          <div className="embed-empty">
            {!canEmbed ? (
              <div>
                <p>Lock a datasource (and create a dashboard) to open the real Tableau Cloud Web Authoring here.</p>
              </div>
            ) : error ? (
              <div className="error">{error}</div>
            ) : status === 'no-src' ? (
              <div>Could not resolve an authoring URL yet. Create the dashboard first, or check your Connected App / login.</div>
            ) : (
              <div>
                <p>Refine your dashboard in the genuine Tableau authoring experience.</p>
                <p className="hint">Some operations (adding shelves/marks/filters) can only be done here by you — the embed hands those off with guidance.</p>
              </div>
            )}
          </div>
        ) : null}
        <div ref={containerRef} style={{ width: '100%', height: '100%', display: status === 'ready' ? 'block' : 'none' }} />
      </div>
      {events.length ? (
        <div className="embed-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
          <span className="muted small">Events:</span>
          <span className="small mono">{events[0]}</span>
        </div>
      ) : null}
    </>
  );
}
