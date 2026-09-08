/**
 * Structured, redacting logger.
 *
 * All structured fields pass through `redact()` so secrets can never reach stdout,
 * a log aggregator, or a trace. This is the ONLY logging entry point the app uses;
 * raw `console.*` is discouraged by lint.
 */
import { getConfig } from '../config/env.js';
import { redact } from './redaction.js';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function enabled(level: Level): boolean {
  const threshold = ORDER[getConfig().app.logLevel] ?? ORDER.INFO;
  return ORDER[level] >= threshold;
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(fields ? { fields: redact(fields) } : {}),
  };
  const serialized = JSON.stringify(line);
  // eslint-disable-next-line no-console -- single sanctioned sink; content is already redacted.
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(serialized);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('DEBUG', scope, m, f),
    info: (m, f) => emit('INFO', scope, m, f),
    warn: (m, f) => emit('WARN', scope, m, f),
    error: (m, f) => emit('ERROR', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('tableaupilot');
