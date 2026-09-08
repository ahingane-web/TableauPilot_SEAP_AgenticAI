/**
 * Application error types + sanitization.
 *
 * `AppError` carries a machine-readable `code`, an HTTP `status`, and an optional
 * `details` object that is ALWAYS redacted before it reaches a client or a log.
 * `sanitizeError()` converts any thrown value into a safe, client-facing shape.
 */
import { redact, redactString } from './redaction.js';

export type ErrorCode =
  | 'VALIDATION'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'PIN_LOCKED'
  | 'PERMISSION_DENIED'
  | 'DATASOURCE_LOCKED'
  | 'PROJECT_MISMATCH'
  | 'APPROVAL_REQUIRED'
  | 'NOT_FOUND'
  | 'TABLEAU_API'
  | 'UNSUPPORTED_OPERATION'
  | 'VERIFICATION_FAILED'
  | 'CONFIG'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  AUTH_REQUIRED: 401,
  AUTH_FAILED: 401,
  PIN_LOCKED: 423,
  PERMISSION_DENIED: 403,
  DATASOURCE_LOCKED: 409,
  PROJECT_MISMATCH: 409,
  APPROVAL_REQUIRED: 409,
  NOT_FOUND: 404,
  TABLEAU_API: 502,
  UNSUPPORTED_OPERATION: 422,
  VERIFICATION_FAILED: 502,
  CONFIG: 500,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** Optional actionable hint shown to the user. */
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, opts?: { details?: Record<string, unknown>; hint?: string }) {
    super(redactString(message));
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = opts?.details;
    this.hint = opts?.hint;
  }
}

export interface SanitizedError {
  code: ErrorCode;
  status: number;
  message: string;
  hint?: string;
  details?: unknown;
}

/** Convert any thrown value into a redacted, client-safe error object. */
export function sanitizeError(err: unknown): SanitizedError {
  if (err instanceof AppError) {
    return {
      code: err.code,
      status: err.status,
      message: err.message,
      hint: err.hint,
      details: err.details ? redact(err.details) : undefined,
    };
  }
  if (err instanceof Error) {
    return {
      code: 'INTERNAL',
      status: 500,
      message: redactString(err.message) || 'An unexpected error occurred.',
    };
  }
  return { code: 'INTERNAL', status: 500, message: 'An unexpected error occurred.' };
}
