import React from 'react';
import { ApiError } from '../api';
import type { SanitizedError } from '../types';

/** Actionable error panel — shows sanitized code, message, and hint. */
export function ErrorPanel({ error, onDismiss }: { error: unknown; onDismiss?: () => void }): React.ReactElement | null {
  if (!error) return null;
  const e: SanitizedError =
    error instanceof ApiError
      ? error.error
      : { code: 'INTERNAL', status: 500, message: error instanceof Error ? error.message : String(error) };
  return (
    <div className="error">
      <div>
        <span className="code">{e.code}</span>
        {e.message}
      </div>
      {e.hint ? <div className="hint">Hint: {e.hint}</div> : null}
      {onDismiss ? (
        <div style={{ marginTop: 8 }}>
          <button className="ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Busy({ label }: { label: string }): React.ReactElement {
  return (
    <span className="muted small">
      <span className="spin" /> {label}
    </span>
  );
}
