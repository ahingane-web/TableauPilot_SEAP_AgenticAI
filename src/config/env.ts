/**
 * Environment configuration loader.
 *
 * Responsibilities:
 *  - Load `.env` once, validate the shape we care about.
 *  - Expose a typed, read-only config object.
 *  - NEVER print secret values. `describeConfig()` returns a redacted summary only.
 *
 * Secrets that belong to a *user* (Tableau PAT, Connected App secret) are NOT read
 * from here — they live in the per-user encrypted vault. This module only handles
 * process-level configuration (LLM gateway, vault pepper, ports, etc.).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let loaded = false;

/** Minimal .env loader (no external dependency) — only sets vars that are unset. */
function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // strip optional surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env present — rely on process env. Do not throw here.
  }
}

export type LlmProvider = 'anthropic' | 'openrouter';

export interface AppConfig {
  readonly llm: {
    readonly provider: LlmProvider;
    readonly model: string;
    readonly anthropicBaseUrl?: string;
    readonly anthropicApiKey?: string;
    readonly anthropicApiKeyHelper?: string;
    readonly anthropicCaCert?: string;
    readonly openRouterApiKey?: string;
    readonly openRouterBaseUrl: string;
  };
  readonly tableau: {
    readonly apiVersion: string;
    readonly versionLabel: string;
    /** Optional local-testing defaults ONLY. Never required. */
    readonly defaultCloudUrl?: string;
    readonly defaultSiteContentUrl?: string;
    readonly connectedApp: {
      readonly clientId?: string;
      readonly secretId?: string;
      readonly secretValue?: string;
    };
  };
  readonly vault: {
    readonly pepper: string;
    readonly dataPath: string;
    readonly maxAttempts: number;
    readonly lockoutSeconds: number;
    readonly sessionTtlSeconds: number;
  };
  readonly app: {
    readonly apiPort: number;
    readonly webPort: number;
    readonly corsOrigins: string[];
    readonly logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    readonly isProduction: boolean;
  };
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  loadDotEnv();

  const provider = (str('LLM_PROVIDER') ?? 'anthropic') as LlmProvider;
  const logLevel = (str('LOG_LEVEL') ?? 'INFO').toUpperCase() as AppConfig['app']['logLevel'];

  cached = {
    llm: {
      provider: provider === 'openrouter' ? 'openrouter' : 'anthropic',
      model: str('LLM_MODEL') ?? 'claude-opus-4-8',
      anthropicBaseUrl: str('ANTHROPIC_BASE_URL'),
      anthropicApiKey: str('ANTHROPIC_API_KEY'),
      anthropicApiKeyHelper: str('ANTHROPIC_API_KEY_HELPER'),
      anthropicCaCert: str('ANTHROPIC_CA_CERT'),
      openRouterApiKey: str('OPENROUTER_API_KEY'),
      openRouterBaseUrl: str('OPENROUTER_BASE_URL') ?? 'https://openrouter.ai/api/v1',
    },
    tableau: {
      apiVersion: str('TABLEAU_API_VERSION') ?? '3.24',
      versionLabel: str('TABLEAU_VERSION') ?? '2026.1',
      defaultCloudUrl: str('TABLEAU_CLOUD_URL'),
      defaultSiteContentUrl: str('TABLEAU_SITE_CONTENT_URL'),
      connectedApp: {
        clientId: str('TABLEAU_CONNECTED_APP_CLIENT_ID'),
        secretId: str('TABLEAU_CONNECTED_APP_SECRET_ID'),
        secretValue: str('TABLEAU_CONNECTED_APP_SECRET_VALUE'),
      },
    },
    vault: {
      pepper: str('VAULT_PEPPER') ?? '',
      dataPath: str('DATA_PATH') ?? './data',
      maxAttempts: num('VAULT_MAX_ATTEMPTS', 5),
      lockoutSeconds: num('VAULT_LOCKOUT_SECONDS', 300),
      sessionTtlSeconds: num('SESSION_TTL_SECONDS', 3600),
    },
    app: {
      apiPort: num('API_PORT', 4000),
      webPort: num('WEB_PORT', 5173),
      corsOrigins: (str('CORS_ORIGINS') ?? 'http://localhost:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      logLevel: ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(logLevel) ? logLevel : 'INFO',
      isProduction: process.env.NODE_ENV === 'production',
    },
  };
  return cached;
}

/**
 * Validate configuration required for the server to boot. Throws with an
 * actionable message (never containing secret values) if something is missing.
 */
export function assertBootConfig(): void {
  const cfg = getConfig();
  const problems: string[] = [];

  if (!cfg.vault.pepper || cfg.vault.pepper === 'replace-with-a-long-random-secret') {
    problems.push(
      'VAULT_PEPPER is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (cfg.llm.provider === 'anthropic') {
    if (!cfg.llm.anthropicBaseUrl) problems.push('ANTHROPIC_BASE_URL is required for the anthropic provider.');
    if (!cfg.llm.anthropicApiKey && !cfg.llm.anthropicApiKeyHelper) {
      problems.push('Provide ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_HELPER for the anthropic provider.');
    }
  } else if (cfg.llm.provider === 'openrouter') {
    if (!cfg.llm.openRouterApiKey) problems.push('OPENROUTER_API_KEY is required for the openrouter provider.');
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}

/** Redacted, safe-to-log summary of the active configuration. Never includes secrets. */
export function describeConfig(): Record<string, unknown> {
  const cfg = getConfig();
  const has = (v: unknown) => (v ? 'set' : 'unset');
  return {
    llmProvider: cfg.llm.provider,
    llmModel: cfg.llm.model,
    anthropicBaseUrl: cfg.llm.anthropicBaseUrl ? '[configured]' : 'unset',
    anthropicAuth: cfg.llm.anthropicApiKey ? 'static-key' : cfg.llm.anthropicApiKeyHelper ? 'helper-command' : 'unset',
    anthropicCaCert: has(cfg.llm.anthropicCaCert),
    openRouterApiKey: has(cfg.llm.openRouterApiKey),
    tableauApiVersion: cfg.tableau.apiVersion,
    connectedApp: has(cfg.tableau.connectedApp.clientId),
    vaultPepper: has(cfg.vault.pepper),
    apiPort: cfg.app.apiPort,
    webPort: cfg.app.webPort,
    logLevel: cfg.app.logLevel,
  };
}
