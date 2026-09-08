/**
 * Server-side LLM abstraction.
 *
 * Resolves a Mastra-compatible language model from environment configuration so the
 * model provider is fully swappable and the browser never sees any credential.
 *
 * Supported providers (from LLM_PROVIDER):
 *   - "anthropic":  Claude via an Anthropic-compatible **gateway** (ANTHROPIC_BASE_URL).
 *                   Auth is either a static key (ANTHROPIC_API_KEY) or a key-helper
 *                   command (ANTHROPIC_API_KEY_HELPER) whose stdout token is captured
 *                   at call time and NEVER logged. A corporate CA bundle
 *                   (ANTHROPIC_CA_CERT) can be supplied for TLS to the gateway.
 *   - "openrouter": OpenAI-compatible endpoint using OPENROUTER_API_KEY.
 *
 * Secrets never enter the model prompt, memory, traces, or the client. Only the
 * transport layer (custom fetch) attaches auth headers to the outbound request.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { MastraLanguageModel } from '@mastra/core/agent';
import { getConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const log = logger.child('llm');

// ---------------------------------------------------------------------------
// API key resolution (static or helper command), with a short in-memory cache
// so we do not spawn the helper on every request. The token value is never logged.
// ---------------------------------------------------------------------------
interface CachedKey {
  value: string;
  expiresAt: number;
}
let anthropicKeyCache: CachedKey | undefined;
const KEY_TTL_MS = 60_000;

function resolveAnthropicKey(): string {
  const cfg = getConfig().llm;
  const now = Date.now();
  if (anthropicKeyCache && anthropicKeyCache.expiresAt > now) {
    return anthropicKeyCache.value;
  }
  let value: string | undefined = cfg.anthropicApiKey;
  if (!value && cfg.anthropicApiKeyHelper) {
    value = runKeyHelper(cfg.anthropicApiKeyHelper);
  }
  if (!value) {
    throw new AppError('CONFIG', 'No Anthropic gateway credential configured.', {
      hint: 'Set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_HELPER in .env.',
    });
  }
  anthropicKeyCache = { value, expiresAt: now + KEY_TTL_MS };
  return value;
}

/** Run the key-helper command, capturing its stdout token. Errors never include the token. */
function runKeyHelper(command: string): string {
  const parts = command.split(/\s+/).filter(Boolean);
  const [cmd, ...args] = parts;
  if (!cmd) throw new AppError('CONFIG', 'ANTHROPIC_API_KEY_HELPER is empty.');
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const token = out.trim();
    if (!token) throw new AppError('CONFIG', 'ANTHROPIC_API_KEY_HELPER produced no token.');
    log.debug('Resolved Anthropic token via key helper', { helper: '[configured]' });
    return token;
  } catch {
    // Never surface stdout/stderr (may contain the token) — report a generic failure.
    throw new AppError('CONFIG', 'Failed to obtain Anthropic token from ANTHROPIC_API_KEY_HELPER.', {
      hint: 'Verify the helper command runs and prints a token to stdout.',
    });
  }
}

// ---------------------------------------------------------------------------
// Custom fetch: injects the freshly-resolved auth header and (optionally) a
// corporate CA bundle via an undici dispatcher. Falls back to global fetch.
// ---------------------------------------------------------------------------
let dispatcherPromise: Promise<unknown> | undefined;

async function getCaDispatcher(caPath: string): Promise<unknown | undefined> {
  if (!dispatcherPromise) {
    dispatcherPromise = (async () => {
      try {
        const ca = readFileSync(caPath, 'utf8');
        const undici = await import('undici');
        return new undici.Agent({ connect: { ca } });
      } catch {
        log.warn('Could not load ANTHROPIC_CA_CERT; falling back to system trust store.');
        return undefined;
      }
    })();
  }
  return dispatcherPromise;
}

function makeAnthropicFetch(caPath?: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // Anthropic-compatible gateways authenticate with the x-api-key header.
    headers.set('x-api-key', resolveAnthropicKey());
    const nextInit: RequestInit & { dispatcher?: unknown } = { ...init, headers };
    if (caPath) {
      const dispatcher = await getCaDispatcher(caPath);
      if (dispatcher) {
        const undici = await import('undici');
        return undici.fetch(input as any, nextInit as any) as unknown as Response;
      }
    }
    return fetch(input, nextInit);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve the configured chat model as a Mastra-compatible language model instance. */
export function resolveModel(): MastraLanguageModel {
  const cfg = getConfig().llm;
  if (cfg.provider === 'anthropic') {
    if (!cfg.anthropicBaseUrl) {
      throw new AppError('CONFIG', 'ANTHROPIC_BASE_URL is required for the anthropic provider.');
    }
    const provider = createAnthropic({
      baseURL: normalizeAnthropicBaseUrl(cfg.anthropicBaseUrl),
      // Real auth is attached by the custom fetch; this placeholder is never used on the wire.
      apiKey: 'managed-by-fetch',
      fetch: makeAnthropicFetch(cfg.anthropicCaCert),
    });
    log.info('LLM configured', { provider: 'anthropic', model: cfg.model });
    return provider(cfg.model) as unknown as MastraLanguageModel;
  }

  // openrouter (OpenAI-compatible)
  if (!cfg.openRouterApiKey) {
    throw new AppError('CONFIG', 'OPENROUTER_API_KEY is required for the openrouter provider.');
  }
  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL: cfg.openRouterBaseUrl,
    apiKey: cfg.openRouterApiKey,
  });
  log.info('LLM configured', { provider: 'openrouter', model: cfg.model });
  return provider(cfg.model) as unknown as MastraLanguageModel;
}

/** The Anthropic SDK expects the base URL to include the API root (…/v1). */
function normalizeAnthropicBaseUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Redacted description of the active LLM config for diagnostics. */
export function describeModel(): Record<string, unknown> {
  const cfg = getConfig().llm;
  return {
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.provider === 'anthropic' ? (cfg.anthropicBaseUrl ? '[configured]' : 'unset') : cfg.openRouterBaseUrl,
    auth: cfg.provider === 'anthropic' ? (cfg.anthropicApiKey ? 'static-key' : 'helper-command') : 'openrouter-key',
    caCert: cfg.anthropicCaCert ? 'configured' : 'none',
  };
}
