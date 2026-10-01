import React, { useEffect, useRef, useState } from 'react';
import { api, getSessionId } from './api';
import type { CreationResult, SessionContext } from './types';
import { ConnectionPanel } from './components/ConnectionPanel';
import { CredentialsPanel } from './components/CredentialsPanel';
import { SetupPanel } from './components/SetupPanel';
import { PlanPanel } from './components/PlanPanel';
import { PublishedViewPanel } from './components/PublishedViewPanel';

/**
 * TableauPilot AI — two-pane copilot.
 * Left: optional Vault panel (Tableau creds + connector summaries) then connect -> lock -> plan -> create.
 * Right: the READ-ONLY published dashboard viewer (preview thumbnail + live embed).
 */
export function App(): React.ReactElement {
  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [booting, setBooting] = useState(true);
  const [lastResult, setLastResult] = useState<CreationResult | null>(null);

  // Draggable splitter: the user can widen/narrow the left workflow pane (and thus the
  // right dashboard-preview pane). `null` means "use the CSS default width".
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [leftWidth, setLeftWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // Show/hide the right-hand published-dashboard pane. When hidden, the workflow pane
  // expands to the full width and the splitter/drag behavior is disabled.
  const [showDashboard, setShowDashboard] = useState(true);
  const [showVault, setShowVault] = useState(false);
  const [vaultNonce, setVaultNonce] = useState(0);

  useEffect(() => {
    if (!dragging) return;
    const MIN_LEFT = 360;
    const MIN_RIGHT = 360;
    function onMove(e: MouseEvent): void {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect) return;
      const max = rect.width - MIN_RIGHT;
      const next = Math.min(Math.max(e.clientX - rect.left, MIN_LEFT), Math.max(MIN_LEFT, max));
      setLeftWidth(next);
    }
    function onUp(): void {
      setDragging(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [dragging]);

  useEffect(() => {
    (async () => {
      if (getSessionId()) {
        try {
          setCtx(await api.session());
        } catch {
          setCtx(null);
        }
      }
      setBooting(false);
    })();
  }, []);

  useEffect(() => {
    if (ctx && !ctx.hasCredentials) setShowVault(true);
  }, [ctx?.hasCredentials]);

  async function logout(): Promise<void> {
    await api.logout();
    setCtx(null);
    setLastResult(null);
  }

  const step = !ctx || !ctx.hasCredentials
    ? 0
    : !ctx.connected || !ctx.projectContext || !ctx.datasourceLock
      ? 1
      : !ctx.workbook
        ? 2
        : 3;

  return (
    <div className="app">
      <div className="topbar">
        <h1>TableauPilot AI</h1>
        <div className="steps" style={{ margin: 0 }}>
          <span className={`step ${step === 0 ? 'active' : step > 0 ? 'done' : ''}`}>Vault</span>
          <span className={`step ${step === 1 ? 'active' : step > 1 ? 'done' : ''}`}>Connect & lock</span>
          <span className={`step ${step === 2 ? 'active' : step > 2 ? 'done' : ''}`}>Plan & create</span>
          <span className={`step ${step === 3 ? 'active' : ''}`}>View</span>
        </div>
        <div className="spacer" />
        {ctx ? (
          <>
            <span className="badge">{ctx.username}</span>
            <span className={`badge ${ctx.connected ? 'ok' : 'off'}`}>{ctx.connected ? 'Tableau connected' : 'not connected'}</span>
            <button className="ghost" onClick={() => setShowDashboard((v) => !v)}>
              {showDashboard ? 'Hide dashboard' : 'Show dashboard'}
            </button>
            <button className="ghost" onClick={logout}>
              Lock vault
            </button>
          </>
        ) : (
          <span className="badge off">locked</span>
        )}
      </div>

      <div className="layout" ref={layoutRef}>
        <div
          className="left"
          style={
            !showDashboard
              ? { width: '100%', minWidth: 0 }
              : leftWidth != null
                ? { width: leftWidth, minWidth: 0 }
                : undefined
          }
        >
          {booting ? (
            <div className="panel">Loading…</div>
          ) : !ctx ? (
            <ConnectionPanel onReady={setCtx} />
          ) : (
            <>
              <CredentialsPanel
                ctx={ctx}
                onChange={setCtx}
                vaultNonce={vaultNonce}
                onVaultChange={() => setVaultNonce((n) => n + 1)}
                expanded={showVault}
                onToggle={() => setShowVault((v) => !v)}
              />
              {ctx.hasCredentials ? (
                <>
                  <SetupPanel
                    ctx={ctx}
                    onChange={setCtx}
                    vaultNonce={vaultNonce}
                    onVaultChange={() => setVaultNonce((n) => n + 1)}
                  />
                  <PlanPanel ctx={ctx} onChange={setCtx} onCreated={setLastResult} />
                </>
              ) : null}
            </>
          )}
        </div>
        {showDashboard ? (
          <>
            <div
              className={`gutter${dragging ? ' dragging' : ''}`}
              onMouseDown={() => setDragging(true)}
              onDoubleClick={() => setLeftWidth(null)}
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize — double-click to reset"
            />
            <div className="right">
              {ctx ? (
                <PublishedViewPanel ctx={ctx} key={lastResult?.workbookId ?? ctx.workbook?.workbookId ?? 'none'} />
              ) : (
                <div className="embed-empty">Unlock your vault to begin.</div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
