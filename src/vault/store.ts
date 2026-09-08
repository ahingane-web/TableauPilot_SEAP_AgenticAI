/**
 * Encrypted-at-rest vault store (single-file JSON).
 *
 * The file only ever contains encrypted blobs + non-secret metadata. It is written
 * with 0600 permissions and lives under DATA_PATH (git-ignored). For a production
 * deployment this could be swapped for a database — the interface is intentionally
 * small.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getConfig } from '../config/env.js';
import type { VaultRecord } from './types.js';

interface VaultFile {
  version: 1;
  users: Record<string, VaultRecord>;
}

function vaultPath(): string {
  return resolve(getConfig().vault.dataPath, 'vault.json');
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadFile(): VaultFile {
  const path = vaultPath();
  if (!existsSync(path)) return { version: 1, users: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as VaultFile;
    if (!parsed.users) return { version: 1, users: {} };
    return parsed;
  } catch {
    // Corrupt file — treat as empty rather than crash; do not log contents.
    return { version: 1, users: {} };
  }
}

function saveFile(file: VaultFile): void {
  const path = vaultPath();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function getRecord(username: string): VaultRecord | undefined {
  return loadFile().users[normalizeUsername(username)];
}

export function putRecord(record: VaultRecord): void {
  const file = loadFile();
  file.users[normalizeUsername(record.username)] = record;
  saveFile(file);
}

export function hasUser(username: string): boolean {
  return Boolean(getRecord(username));
}

export function listUsernames(): string[] {
  return Object.keys(loadFile().users);
}
