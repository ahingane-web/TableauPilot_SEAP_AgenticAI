/**
 * Secret redaction utilities.
 *
 * These provide defense-in-depth: even though the architecture keeps secrets out
 * of logs/traces/LLM context by construction, every value that crosses a boundary
 * (log line, trace attribute, error message, API response) is passed through
 * `redact()` so an accidental secret cannot leak.
 */

/** Substrings/keys that indicate a value is sensitive and must never be emitted. */
const SENSITIVE_KEY_PATTERN =
  /(pat|password|secret|token|api[_-]?key|authorization|auth|pepper|pin|credential|jwt|bearer|cookie)/i;

/** Value patterns that look like secrets regardless of the key they appear under. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g, // OpenRouter keys
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, // Bearer tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
  /X-Tableau-Auth[:=]\s*[A-Za-z0-9._-]{10,}/gi, // Tableau REST tokens
];

export const REDACTED = '[REDACTED]';

/** Redact secret-looking substrings inside a free-form string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redact an arbitrary value for safe logging.
 * - Object keys matching the sensitive pattern have their values replaced.
 * - String values are scrubbed for secret-looking substrings.
 * - Cycles are handled.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, seen);
      }
    }
    return out;
  }
  return value;
}

/** True if a string appears to contain a secret. Used by processors/guards. */
export function looksLikeSecret(input: string): boolean {
  return SECRET_VALUE_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(input);
  });
}
