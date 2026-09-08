/**
 * Shared persistence for Mastra (memory, traces, workflow snapshots).
 * A local libSQL/SQLite file under DATA_PATH. Contains only non-sensitive
 * app data + agent memory — never Tableau or gateway secrets.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibSQLStore } from '@mastra/libsql';
import { getConfig } from '../config/env.js';

let store: LibSQLStore | undefined;

export function getStorage(): LibSQLStore {
  if (store) return store;
  const dataPath = resolve(getConfig().vault.dataPath);
  if (!existsSync(dataPath)) mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  const file = resolve(dataPath, 'mastra.db');
  store = new LibSQLStore({ id: 'tableaupilot', url: `file:${file}` });
  return store;
}
