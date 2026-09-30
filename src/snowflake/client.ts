/**
 * Minimal Snowflake connector client (pure TypeScript, no SDK).
 *
 * This is the ONLY module that talks to Snowflake. It:
 *   1. authenticates with username/password via the session REST login
 *      (`POST /session/v1/login-request`),
 *   2. lists warehouses / databases / schemas / tables (`SHOW …`),
 *   3. describes scalar columns (`DESCRIBE TABLE`),
 *   4. queries rows (to materialize a local `.hyper` extract).
 *
 * It never talks to Tableau. Salesforce / Excel / BigQuery / Data Cloud HTTP stay in
 * their own packages; this module does not edit that code.
 *
 * Security: credentials and the session token live in memory only and are never
 * logged. Only sanitized, secret-free diagnostics are emitted.
 */
import { randomUUID } from 'node:crypto';
import type { HyperColumnType } from '../tableau/authoring/tdsGenerator.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';

const log = logger.child('snowflake');

const NESTED_TYPES = new Set(['VARIANT', 'OBJECT', 'ARRAY', 'VECTOR', 'MAP', 'GEOGRAPHY', 'GEOMETRY']);
const USER_AGENT = 'TableauPilot/0.1.0';
const SNOWFLAKE_ACCEPT = 'application/snowflake';
const QUERY_IN_PROGRESS = '333334';
const MAX_RESULT_POLLS = 8;

/** Raw connector credentials collected from the user. Secret — memory only. */
export interface SnowflakeCredentials {
  /** Account URL or host, e.g. `https://xy12345.snowflakecomputing.com`. */
  url: string;
  /** Compute warehouse used to open the session (and the default picker value). */
  warehouse: string;
  username: string;
  password: string;
}

/** Live Snowflake session used for REST SQL. Secret — memory only. */
export interface SnowflakeAuth {
  /** Session token (`Authorization: Snowflake Token="…"`). */
  token: string;
  /** Account host, e.g. `xy12345.snowflakecomputing.com` (TDS `server` / caption). */
  host: string;
  /** `https://{host}`. */
  origin: string;
  /** Account identifier parsed from the host. */
  account: string;
  username: string;
  /** Warehouse currently set on the session (`USE WAREHOUSE`). */
  warehouse: string;
  /** Monotonic sequence id required by `/queries/v1/query-request`. */
  sequenceId: number;
}

export interface SnowflakeNamed {
  name: string;
  label: string;
}

export interface SnowflakeTable {
  name: string;
  label: string;
}

export interface SnowflakeField {
  /** Real column name (used as `remote-name` and in SQL). May contain spaces. */
  name: string;
  label: string;
  /** Snowflake type token, e.g. NUMBER(38,0), VARCHAR, DATE, TIMESTAMP_NTZ. */
  type: string;
  nillable: boolean;
}

type TwbType = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

/** Map a Snowflake column type to the Tableau local datatype family. */
export function snowflakeToTwbType(sfType: string): TwbType {
  const parsed = parseSnowflakeType(sfType);
  switch (parsed.base) {
    case 'BOOLEAN':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'TIMESTAMP':
    case 'TIMESTAMP_NTZ':
    case 'TIMESTAMP_LTZ':
    case 'TIMESTAMP_TZ':
    case 'DATETIME':
      return 'datetime';
    case 'INTEGER':
    case 'INT':
    case 'BIGINT':
    case 'SMALLINT':
    case 'TINYINT':
    case 'BYTEINT':
      return 'integer';
    case 'NUMBER':
    case 'DECIMAL':
    case 'NUMERIC':
      return parsed.scale === 0 ? 'integer' : 'real';
    case 'FLOAT':
    case 'FLOAT4':
    case 'FLOAT8':
    case 'DOUBLE':
    case 'DOUBLE PRECISION':
    case 'REAL':
      return 'real';
    default:
      return 'string';
  }
}

/** Map a Snowflake column type to the Hyper extract column category. */
export function snowflakeToHyperType(sfType: string): HyperColumnType {
  switch (snowflakeToTwbType(sfType)) {
    case 'integer':
      return 'int';
    case 'real':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamp';
    default:
      return 'text';
  }
}

/** Double-quote a Snowflake identifier (preserves spaces / mixed case). */
export function quoteIdent(name: string): string {
  return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

/** Normalize a user-supplied server URL to `https://{host}` with no trailing path. */
export function normalizeSnowflakeUrl(raw: string): { origin: string; host: string; account: string } {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new AppError('VALIDATION', 'A Snowflake server URL is required (e.g. xy12345.snowflakecomputing.com).');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new AppError('VALIDATION', 'The Snowflake server URL is not a valid URL.');
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith('.snowflakecomputing.com') && host !== 'snowflakecomputing.com') {
    throw new AppError(
      'VALIDATION',
      'The Snowflake server URL must be an account host ending in .snowflakecomputing.com.',
    );
  }
  const account = host.replace(/\.snowflakecomputing\.com$/i, '');
  if (!account) {
    throw new AppError('VALIDATION', 'Could not parse a Snowflake account identifier from the server URL.');
  }
  return { origin: `https://${host}`, host, account };
}

/**
 * Authenticate to Snowflake via username/password session login.
 * Returns a live session used for subsequent SHOW / DESCRIBE / SELECT calls.
 */
export async function connect(creds: SnowflakeCredentials): Promise<SnowflakeAuth> {
  const username = String(creds.username ?? '').trim();
  const warehouse = String(creds.warehouse ?? '').trim();
  if (!username) throw new AppError('VALIDATION', 'A Snowflake username is required.');
  if (!creds.password) throw new AppError('VALIDATION', 'A Snowflake password is required.');
  if (!warehouse) throw new AppError('VALIDATION', 'A Snowflake warehouse is required.');

  const { origin, host, account } = normalizeSnowflakeUrl(creds.url);
  const requestId = randomUUID();
  const endpoint =
    `${origin}/session/v1/login-request?warehouse=${encodeURIComponent(warehouse)}` +
    `&requestId=${encodeURIComponent(requestId)}`;
  const body = {
    data: {
      CLIENT_APP_ID: 'TableauPilot',
      CLIENT_APP_VERSION: '0.1.0',
      ACCOUNT_NAME: account,
      LOGIN_NAME: username,
      PASSWORD: creds.password,
      CLIENT_ENVIRONMENT: { APPLICATION: 'TableauPilot' },
    },
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: snowflakeHeaders(),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Snowflake: ${redactString(String(err))}`);
  }
  const text = await res.text().catch(() => '');
  let parsed: { success?: boolean; message?: string; data?: { token?: string; sessionId?: unknown } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new AppError('CONNECTOR_API', `Snowflake login returned a non-JSON response (HTTP ${res.status}).`);
  }
  const token = String(parsed.data?.token ?? '').trim();
  if (!res.ok || parsed.success === false || !token) {
    const hint = redactString(String(parsed.message ?? '')).trim();
    throw new AppError(
      'AUTH_FAILED',
      `Snowflake login failed${hint ? `: ${hint}` : ` (HTTP ${res.status})`}.`,
      { hint: 'Check the server URL, warehouse, username, and password.' },
    );
  }

  log.info('Connected to Snowflake', { host, warehouse });
  return {
    token,
    host,
    origin,
    account,
    username,
    warehouse,
    sequenceId: 0,
  };
}

export async function listWarehouses(auth: SnowflakeAuth): Promise<SnowflakeNamed[]> {
  const rows = await runQuery(auth, 'SHOW WAREHOUSES');
  return namedFromShow(rows, ['name']);
}

export async function listDatabases(auth: SnowflakeAuth, warehouse: string): Promise<SnowflakeNamed[]> {
  await ensureWarehouse(auth, warehouse);
  const rows = await runQuery(auth, 'SHOW DATABASES');
  return namedFromShow(rows, ['name', 'database_name']);
}

export async function listSchemas(
  auth: SnowflakeAuth,
  warehouse: string,
  database: string,
): Promise<SnowflakeNamed[]> {
  await ensureWarehouse(auth, warehouse);
  const db = requireIdent(database, 'database');
  const rows = await runQuery(auth, `SHOW SCHEMAS IN DATABASE ${quoteIdent(db)}`);
  return namedFromShow(rows, ['name', 'schema_name']).filter(
    (s) => s.name.toUpperCase() !== 'INFORMATION_SCHEMA',
  );
}

export async function listTables(
  auth: SnowflakeAuth,
  warehouse: string,
  database: string,
  schema: string,
): Promise<SnowflakeTable[]> {
  await ensureWarehouse(auth, warehouse);
  const db = requireIdent(database, 'database');
  const sch = requireIdent(schema, 'schema');
  const rows = await runQuery(auth, `SHOW TABLES IN SCHEMA ${quoteIdent(db)}.${quoteIdent(sch)}`);
  return namedFromShow(rows, ['name', 'table_name']).map((t) => ({ name: t.name, label: t.label }));
}

export async function describeTable(
  auth: SnowflakeAuth,
  warehouse: string,
  database: string,
  schema: string,
  table: string,
): Promise<SnowflakeField[]> {
  await ensureWarehouse(auth, warehouse);
  const db = requireIdent(database, 'database');
  const sch = requireIdent(schema, 'schema');
  const tbl = requireIdent(table, 'table');
  const rows = await runQuery(auth, `DESCRIBE TABLE ${quoteIdent(db)}.${quoteIdent(sch)}.${quoteIdent(tbl)}`);
  const fields: SnowflakeField[] = [];
  for (const row of rows) {
    const name = String(cell(row, ['name', 'column_name']) ?? '').trim();
    const type = String(cell(row, ['type', 'data_type']) ?? '').trim();
    if (!name) continue;
    const parsed = parseSnowflakeType(type);
    if (NESTED_TYPES.has(parsed.base)) continue;
    const nullRaw = String(cell(row, ['null?', 'null', 'nullable']) ?? 'Y').toUpperCase();
    const nillable = nullRaw !== 'N' && nullRaw !== 'NO' && nullRaw !== 'FALSE';
    fields.push({ name, label: name, type: type || 'VARCHAR', nillable });
  }
  if (fields.length === 0) {
    throw new AppError('CONNECTOR_API', `Snowflake table "${tbl}" exposes no scalar columns to model.`);
  }
  return fields;
}

/**
 * Query rows for an extract. Returns arrays aligned to `fields` order with Hyper-sidecar
 * value formats (date `YYYY-MM-DD`, timestamp `YYYY-MM-DDTHH:MM:SS`).
 */
export async function queryRows(
  auth: SnowflakeAuth,
  input: {
    warehouse: string;
    database: string;
    schema: string;
    table: string;
    fields: SnowflakeField[];
    maxRows?: number;
  },
): Promise<Array<Array<unknown>>> {
  await ensureWarehouse(auth, input.warehouse);
  const db = requireIdent(input.database, 'database');
  const sch = requireIdent(input.schema, 'schema');
  const tbl = requireIdent(input.table, 'table');
  const maxRows = input.maxRows ?? 100_000;
  if (input.fields.length === 0) {
    throw new AppError('VALIDATION', 'No Snowflake columns to query.');
  }
  const selectList = input.fields.map((f) => quoteIdent(f.name)).join(', ');
  const sql =
    `SELECT ${selectList} FROM ${quoteIdent(db)}.${quoteIdent(sch)}.${quoteIdent(tbl)} LIMIT ${maxRows}`;
  const coercers = input.fields.map((f) => rowCoercer(f.type));
  const rows = await runQuery(auth, sql);
  const out: Array<Array<unknown>> = [];
  for (const row of rows) {
    if (out.length >= maxRows) break;
    // Positional: SELECT list order matches `fields`. Do not look up by name — a null
    // middle column must not fall through to another cell.
    out.push(input.fields.map((_f, i) => coercers[i]!(row.cells[i] ?? null)));
  }
  log.info('Queried Snowflake rows', { table: tbl, fields: input.fields.length, rows: out.length });
  return out;
}

// --- internals ----------------------------------------------------------------------------

function parseSnowflakeType(raw: string): { base: string; scale: number } {
  const s = String(raw ?? '').trim();
  const m = /^([A-Z][A-Z0-9_ ]*?)(?:\(([^)]*)\))?$/i.exec(s);
  const base = (m?.[1] ?? s).trim().toUpperCase().replace(/\s+/g, ' ');
  const args = m?.[2];
  if (args != null && (base === 'NUMBER' || base === 'DECIMAL' || base === 'NUMERIC')) {
    const parts = args.split(',').map((p) => p.trim());
    const scale = parts.length > 1 ? Number(parts[1]) : 0;
    return { base, scale: Number.isFinite(scale) ? scale : 0 };
  }
  if (base === 'NUMBER' || base === 'DECIMAL' || base === 'NUMERIC') {
    return { base, scale: 0 };
  }
  return { base, scale: 0 };
}

function requireIdent(raw: string, kind: string): string {
  const v = String(raw ?? '').trim();
  if (!v || [...v].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new AppError('VALIDATION', `Invalid Snowflake ${kind} name.`);
  }
  return v;
}

async function ensureWarehouse(auth: SnowflakeAuth, warehouse: string): Promise<void> {
  const wh = requireIdent(warehouse, 'warehouse');
  if (auth.warehouse.toUpperCase() === wh.toUpperCase()) {
    auth.warehouse = wh;
    return;
  }
  await runQuery(auth, `USE WAREHOUSE ${quoteIdent(wh)}`);
  auth.warehouse = wh;
}

interface QueryRow {
  cells: unknown[];
  byName: Record<string, unknown>;
}

function snowflakeHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: SNOWFLAKE_ACCEPT,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (token) headers.Authorization = `Snowflake Token="${token}"`;
  return headers;
}

type SnowflakeQueryResponse = {
  success?: boolean;
  message?: string;
  code?: string;
  data?: {
    rowtype?: Array<{ name?: string }>;
    rowset?: unknown[];
    errorMessage?: string;
    errorCode?: string;
    queryId?: string;
    getResultUrl?: string;
  };
};

async function parseJsonBody(res: Response, kind: string): Promise<SnowflakeQueryResponse> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text) as SnowflakeQueryResponse;
  } catch {
    throw new AppError('CONNECTOR_API', `Snowflake ${kind} returned a non-JSON response (HTTP ${res.status}).`);
  }
}

async function runQuery(auth: SnowflakeAuth, sql: string): Promise<QueryRow[]> {
  auth.sequenceId += 1;
  const endpoint = `${auth.origin}/queries/v1/query-request?requestId=${encodeURIComponent(randomUUID())}`;
  const body = {
    sqlText: sql,
    asyncExec: false,
    sequenceId: auth.sequenceId,
    isInternal: false,
    describeOnly: false,
  };
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: snowflakeHeaders(auth.token),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error querying Snowflake: ${redactString(String(err))}`);
  }
  const parsed = await parseJsonBody(res, 'query');
  return readQueryRows(auth, parsed, res.status, 0);
}

async function readQueryRows(
  auth: SnowflakeAuth,
  parsed: SnowflakeQueryResponse,
  status: number,
  depth: number,
): Promise<QueryRow[]> {
  if (!status || status >= 400 || parsed.success === false) {
    const hint = redactString(String(parsed.message ?? parsed.data?.errorMessage ?? '')).trim();
    throw new AppError(
      'CONNECTOR_API',
      `Snowflake query failed${hint ? `: ${hint}` : status ? ` (HTTP ${status})` : ''}.`,
    );
  }
  const code = String(parsed.code ?? '');
  const resultUrl = String(parsed.data?.getResultUrl ?? '').trim();
  const queryId = String(parsed.data?.queryId ?? '').trim();
  const rowset = parsed.data?.rowset;
  const needsPoll =
    code === QUERY_IN_PROGRESS || (!Array.isArray(rowset) && Boolean(resultUrl || queryId));
  if (needsPoll && depth < MAX_RESULT_POLLS) {
    const nextUrl = resultUrl
      ? resultUrl.startsWith('http')
        ? resultUrl
        : `${auth.origin}${resultUrl.startsWith('/') ? '' : '/'}${resultUrl}`
      : `${auth.origin}/queries/${encodeURIComponent(queryId)}/result`;
    let res: Response;
    try {
      res = await fetch(nextUrl, { method: 'GET', headers: snowflakeHeaders(auth.token) });
    } catch (err) {
      throw new AppError('CONNECTOR_API', `Network error fetching Snowflake results: ${redactString(String(err))}`);
    }
    const next = await parseJsonBody(res, 'query result');
    return readQueryRows(auth, next, res.status, depth + 1);
  }
  if (!Array.isArray(rowset)) {
    if (code === QUERY_IN_PROGRESS || resultUrl || queryId) {
      throw new AppError('CONNECTOR_API', 'Snowflake query did not return a rowset.');
    }
    return [];
  }
  const rowtype = Array.isArray(parsed.data?.rowtype) ? parsed.data!.rowtype! : [];
  const names = rowtype.map((c) => String(c.name ?? '').toLowerCase());
  return rowset.map((raw) => {
    const cells = Array.isArray(raw) ? raw : [];
    const byName: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (n) byName[n] = cells[i];
    }
    if (!Array.isArray(raw) && raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        byName[k.toLowerCase()] = v;
      }
    }
    return { cells, byName };
  });
}

function cell(row: QueryRow, names: string[]): unknown {
  for (const n of names) {
    const key = n.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(row.byName, key)) {
      const v = row.byName[key];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

function namedFromShow(rows: QueryRow[], nameKeys: string[]): SnowflakeNamed[] {
  const out: SnowflakeNamed[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = String(cell(row, nameKeys) ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, label: name });
  }
  return out;
}

function rowCoercer(sfType: string): (v: unknown) => unknown {
  const twb = snowflakeToTwbType(sfType);
  return (raw: unknown): unknown => {
    if (raw == null || raw === '') return null;
    const s = typeof raw === 'string' ? raw : String(raw);
    switch (twb) {
      case 'integer': {
        const n = Number(s);
        return Number.isFinite(n) ? Math.trunc(n) : null;
      }
      case 'real': {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      case 'boolean':
        return s === 'true' || s === '1' || s.toUpperCase() === 'TRUE';
      case 'date':
        return s.slice(0, 10);
      case 'datetime':
        return s.replace(' ', 'T').slice(0, 19);
      default:
        return s;
    }
  };
}
