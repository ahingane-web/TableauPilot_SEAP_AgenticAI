import React, { useEffect, useRef, useState } from 'react';
import { api, getSessionId } from './api';
import type { CreationResult, SessionContext } from './types';
import { LoginView } from './components/LoginView';
import { CredentialsPanel } from './components/CredentialsPanel';
import { SetupPanel } from './components/SetupPanel';
import { PlanPanel } from './components/PlanPanel';
import { PublishedViewPanel } from './components/PublishedViewPanel';
import { LogoMark, User, Lock } from './components/icons';

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
        <div className="brand">
          <span className="mark"><LogoMark size={26} /></span>
          <span className="name">TableauPilot AI</span>
        </div>
        <div className="nav" role="tablist" aria-label="Workflow">
          <button type="button" className={`tab ${step === 0 ? 'active' : step > 0 ? 'done' : ''}`}>Vault</button>
          <button type="button" className={`tab ${step === 1 ? 'active' : step > 1 ? 'done' : ''}`}>Connect & Lock</button>
          <button type="button" className={`tab ${step === 2 ? 'active' : step > 2 ? 'done' : ''}`}>Plan & Create</button>
          <button type="button" className={`tab ${step === 3 ? 'active' : ''}`}>View</button>
        </div>
        <div className="spacer" />
        {ctx ? (
          <>
            <span className="userchip">
              <span className="av"><User size={14} /></span>
              {ctx.username}
            </span>
            <span className={`badge ${ctx.connected ? 'ok' : 'off'}`}>
              <span className="statusdot" />
              {ctx.connected ? 'Tableau connected' : 'not connected'}
            </span>
            <button className="ghost" onClick={() => setShowDashboard((v) => !v)}>
              {showDashboard ? 'Hide dashboard' : 'Show dashboard'}
            </button>
            <button onClick={logout}>
              <Lock size={15} />
              Lock vault
            </button>
          </>
        ) : (
          <span className="badge off">
            <span className="statusdot" />
            locked
          </span>
        )}
      </div>

      {booting ? (
        <div className="layout">
          <div className="left">
            <div className="panel">Loading…</div>
          </div>
        </div>
      ) : !ctx ? (
        // Locked: full-screen two-column login (unlock/register form + marketing hero).
        <div className="layout">
          <LoginView onReady={setCtx} />
        </div>
      ) : (
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
                <PublishedViewPanel ctx={ctx} key={lastResult?.workbookId ?? ctx.workbook?.workbookId ?? 'none'} />
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
