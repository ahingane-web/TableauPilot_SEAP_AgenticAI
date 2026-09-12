/**
 * Local Salesforce extract packaging.
 *
 * Materializes a `.hyper` extract from queried Salesforce rows and packages it with a
 * generated `.tds` into a `.tdsx`, by invoking the Python Hyper API sidecar
 * (`scripts/hyper/build_tdsx.py`). This is the one place the project shells out to
 * Python — writing a `.hyper` has no Node binding (see docs/python-dependency-decision.md).
 *
 * Data flows through temp files (schema.json + data.ndjson), never argv, so no row
 * data or secrets appear in the process table. The temp directory is always removed.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getConfig } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { redactString } from '../../utils/redaction.js';
import type { HyperColumnType } from '../authoring/tdsGenerator.js';

const log = logger.child('publishing:hyper');

/** One extract column: the Salesforce field API name + its Hyper column category. */
export interface ExtractColumn {
  name: string;
  type: HyperColumnType;
}

export interface BuildExtractTdsxInput {
  /** The generated `.tds` XML (its extract `dbname` must be `Data/Extracts/<hyperName>`). */
  tdsXml: string;
  /** Salesforce object / extract table name. */
  object: string;
  /** Extract `.hyper` filename bundled under `Data/Extracts/` (matches the `.tds` dbname). */
  hyperName: string;
  /** Column schema (order defines the row-array alignment). */
  schema: ExtractColumn[];
  /** Rows as arrays aligned to `schema` order (values are JSON-serialisable). */
  rows: Array<Array<unknown>>;
}

const SETUP_HINT = 'Run `npm run setup:hyper` to create the .venv-hyper virtualenv with the Tableau Hyper API.';

/**
 * Build a `.tdsx` (`.tds` + materialized `.hyper`) and return its bytes. Throws a
 * `TABLEAU_API` AppError with an actionable hint if the Python sidecar is missing or fails.
 */
export async function buildExtractTdsx(input: BuildExtractTdsxInput): Promise<Buffer> {
  const cfg = getConfig();
  const python = cfg.hyper.python;
  const scriptPath = resolve(process.cwd(), 'scripts/hyper/build_tdsx.py');

  if (!existsSync(python)) {
    throw new AppError('TABLEAU_API', `Python interpreter for the Hyper extract builder not found at "${python}".`, {
      hint: SETUP_HINT,
    });
  }

  const dir = await mkdtemp(join(tmpdir(), 'tp-hyper-'));
  const tdsPath = join(dir, 'datasource.tds');
  const schemaPath = join(dir, 'schema.json');
  const dataPath = join(dir, 'data.ndjson');
  const outPath = join(dir, 'extract.tdsx');

  try {
    const ndjson = input.rows.map((row) => JSON.stringify(row)).join('\n') + (input.rows.length ? '\n' : '');
    await Promise.all([
      writeFile(tdsPath, input.tdsXml, 'utf8'),
      writeFile(schemaPath, JSON.stringify(input.schema), 'utf8'),
      writeFile(dataPath, ndjson, 'utf8'),
    ]);

    await runPython(python, [
      scriptPath,
      '--tds', tdsPath,
      '--schema', schemaPath,
      '--data', dataPath,
      '--object', input.object,
      '--hyper-name', input.hyperName,
      '--out', outPath,
    ]);

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/** Spawn the sidecar and resolve on exit code 0, else reject with a sanitized AppError. */
function runPython(python: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      reject(
        new AppError('TABLEAU_API', `Could not run the Hyper extract builder: ${redactString(String(err))}`, {
          hint: SETUP_HINT,
        }),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        log.info('Built Salesforce extract .tdsx', { summary: stdout.trim() || undefined });
        resolvePromise();
        return;
      }
      const detail = redactString((stderr || stdout).trim()).slice(0, 800);
      reject(
        new AppError('TABLEAU_API', `Hyper extract build failed (exit ${code}).${detail ? ` ${detail}` : ''}`, {
          hint: code === 3 ? SETUP_HINT : 'Check the Salesforce object fields and try again.',
        }),
      );
    });
  });
}
