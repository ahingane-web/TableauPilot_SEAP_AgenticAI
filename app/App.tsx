import React, { useEffect, useState } from 'react';
import { api, getSessionId } from './api';
import type { CreationResult, SessionContext } from './types';
import { ConnectionPanel } from './components/ConnectionPanel';
import { SetupPanel } from './components/SetupPanel';
import { PlanPanel } from './components/PlanPanel';
import { AuthoringPanel } from './components/AuthoringPanel';

/**
 * TableauPilot AI — two-pane copilot.
 * Left: AI planning workflow (identity/PIN -> connect -> lock -> plan -> approve -> create -> verify).
 * Right: the REAL Tableau Cloud Web Authoring embed for human refinement.
 */
export function App(): React.ReactElement {
  const [ctx, setCtx] = useState<SessionContext | null>(null);
  const [booting, setBooting] = useState(true);
  const [lastResult, setLastResult] = useState<CreationResult | null>(null);

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
          <span className={`step ${step === 3 ? 'active' : ''}`}>Refine</span>
        </div>
        <div className="spacer" />
        {ctx ? (
          <>
            <span className="badge">{ctx.username}</span>
            <span className={`badge ${ctx.connected ? 'ok' : 'off'}`}>{ctx.connected ? 'Tableau connected' : 'not connected'}</span>
            <button className="ghost" onClick={logout}>
              Lock vault
            </button>
          </>
        ) : (
          <span className="badge off">locked</span>
        )}
      </div>

      <div className="layout">
        <div className="left">
          {booting ? (
            <div className="panel">Loading…</div>
          ) : !ctx || !ctx.hasCredentials ? (
            <ConnectionPanel onReady={setCtx} />
          ) : (
            <>
              <SetupPanel ctx={ctx} onChange={setCtx} />
              <PlanPanel ctx={ctx} onChange={setCtx} onCreated={setLastResult} />
            </>
          )}
        </div>
        <div className="right">
          {ctx ? (
            <AuthoringPanel ctx={ctx} key={lastResult?.workbookId ?? ctx.workbook?.workbookId ?? 'none'} />
          ) : (
            <div className="embed-empty">Unlock your vault to begin.</div>
          )}
        </div>
      </div>
    </div>
  );
}
