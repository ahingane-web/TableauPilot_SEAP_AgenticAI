/**
 * Lightweight, redacting tracing/observability helpers.
 *
 * Mastra Studio (via `mastra dev`) natively visualizes agent runs, tool calls, and
 * workflow execution. This module adds structured, redacted spans/events for the
 * app's own service + workflow steps so latency, errors, and step transitions are
 * observable in logs/traces. Every attribute passes through the redactor, so no
 * secret can appear in a span.
 */
import { logger } from '../utils/logger.js';
import { redact } from '../utils/redaction.js';
import { sanitizeError } from '../utils/errors.js';

const log = logger.child('trace');

export type SpanAttributes = Record<string, unknown>;

/** Record a point-in-time event (workflow step transition, approval, etc.). */
export function recordEvent(name: string, attributes?: SpanAttributes): void {
  log.info(`event:${name}`, attributes ? (redact(attributes) as SpanAttributes) : undefined);
}

/** Wrap an async operation in a traced span with duration + error capture. */
export async function withSpan<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  log.debug(`span:start:${name}`, redact(attributes) as SpanAttributes);
  try {
    const result = await fn();
    log.info(`span:end:${name}`, { durationMs: Date.now() - start, status: 'ok' });
    return result;
  } catch (err) {
    const safe = sanitizeError(err);
    log.error(`span:error:${name}`, { durationMs: Date.now() - start, code: safe.code, message: safe.message });
    throw err;
  }
}
