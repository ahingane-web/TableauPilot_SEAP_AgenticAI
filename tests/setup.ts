/**
 * Vitest global setup. Establishes a deterministic, isolated environment BEFORE any
 * module reads config (getConfig caches on first call). Sets a test pepper and a
 * throwaway data directory so vault tests never touch real user data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VAULT_PEPPER = process.env.VAULT_PEPPER ?? 'test-pepper-0123456789abcdef-0123456789abcdef';
process.env.DATA_PATH = process.env.DATA_PATH ?? mkdtempSync(join(tmpdir(), 'tp-test-'));
process.env.VAULT_MAX_ATTEMPTS = process.env.VAULT_MAX_ATTEMPTS ?? '5';
process.env.VAULT_LOCKOUT_SECONDS = process.env.VAULT_LOCKOUT_SECONDS ?? '300';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'anthropic';
process.env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? 'https://example.test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-test-key-value';
