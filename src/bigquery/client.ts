/**
 * Minimal Google BigQuery connector client (pure TypeScript, no external deps).
 *
 * This is the ONLY module that talks to Google Cloud. It uses an OAuth 2.0 access token
 * (obtained via the browser sign-in flow in `oauth.ts`) as a Bearer token against the
 * Cloud Resource Manager + BigQuery REST APIs to:
 *   - list the account's GCP projects (billing + data projects),
 *   - list datasets in a project, and tables in a dataset,
 *   - describe a table's columns (name/type/nullability),
 *   - query a table's rows (to materialize a local `.hyper` extract).
 *
 * It never talks to Tableau. Structurally analogous to `src/salesforce/client.ts`.
 *
 * Security: the access token lives in memory only and is never logged. Only sanitized,
 * secret-free diagnostics are emitted.
 *
 * Identifier note: BigQuery column names may contain spaces/hyphens (e.g. `Order Date`,
 * `Sub-Category`). Each described field therefore carries BOTH the real BigQuery name
 * (`name`, used for SQL + the live connection `remote-name`) and an identifier-safe,
 * unique `safeName` (used as the Tableau field identity and the Hyper extract column), so
 * the columns survive the same deterministic `.tds`/`.hyper` pipeline the other connectors
 * use.
 */
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';
import type { HyperColumnType } from '../tableau/authoring/tdsGenerator.js';

const log = logger.child('bigquery');

const RESOURCE_MANAGER_BASE = 'https://cloudresourcemanager.googleapis.com/v1';
const BIGQUERY_BASE = 'https://bigquery.googleapis.com/bigquery/v2';

/** A GCP project (serves both the "Billing Project" and "Project" pickers). */
export interface BigQueryProject {
  /** Project id, e.g. `tableauagent-510111` (used as CATALOG / EXECCATALOG). */
  id: string;
  /** Human display name, e.g. `TableauAgent` (used as the connection `project` attr). */
  name: string;
}

/** A BigQuery dataset within a project. */
export interface BigQueryDataset {
  /** Dataset id, e.g. `TableauAgentDataset` (used as the connection `schema` attr). */
  id: string;
  /** Optional location (e.g. `US`), for display. */
  location?: string;
}

/** A BigQuery table (or view) within a dataset. */
export interface BigQueryTable {
  /** Table id, e.g. `Orders`. */
  id: string;
  /** `TABLE` | `VIEW` | ... (from the REST `type`). */
  type?: string;
}

/**
 * A described BigQuery column. `name` is the REAL BigQuery column name (may contain spaces);
 * `safeName` is the identifier-safe, unique Tableau/Hyper field name derived from it.
 */
export interface BigQueryField {
  /** Real BigQuery column name (used for SQL SELECT + live connection `remote-name`). */
  name: string;
  /** Identifier-safe, unique field name (Tableau field identity + Hyper extract column). */
  safeName: string;
  /** BigQuery standard-SQL scalar type, e.g. STRING, INT64, FLOAT64, NUMERIC, BOOL, DATE, TIMESTAMP. */
  type: string;
  /** Whether the column is nullable (maps to `contains-null`). */
  nillable: boolean;
}

/** Access-token holder used by every request. */
export interface BigQueryAuth {
  accessToken: string;
}

/**
 * BigQuery scalar types that map cleanly onto a flat extract column. Nested (`RECORD`/
 * `STRUCT`) and repeated (`ARRAY`) fields cannot be represented as a single Hyper column,
 * so `describeTable` skips them (mirrors how the Salesforce client excludes compound types).
 */
const SCALAR_BQ_TYPES = new Set([
  'STRING',
  'BYTES',
  'INTEGER',
  'INT64',
  'FLOAT',
  'FLOAT64',
  'NUMERIC',
  'BIGNUMERIC',
  'DECIMAL',
  'BIGDECIMAL',
  'BOOLEAN',
  'BOOL',
  'TIMESTAMP',
  'DATE',
  'TIME',
  'DATETIME',
  'GEOGRAPHY',
  'JSON',
]);

/** Map a BigQuery standard-SQL type to the Tableau `salesforceType` token the shared `.tds` helpers consume. */
export function bigQueryToSalesforceToken(bqType: string): string {
  switch ((bqType ?? '').toUpperCase()) {
    case 'INTEGER':
    case 'INT64':
      return 'int';
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'DECIMAL':
    case 'BIGDECIMAL':
      return 'double';
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'DATETIME':
    case 'TIMESTAMP':
      return 'datetime';
    default:
      // STRING, BYTES, TIME, GEOGRAPHY, JSON, etc.
      return 'string';
  }
}

/** Map a BigQuery standard-SQL type to the Hyper extract column category. */
export function bigQueryToHyperType(bqType: string): HyperColumnType {
  switch ((bqType ?? '').toUpperCase()) {
    case 'INTEGER':
    case 'INT64':
      return 'int';
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'DECIMAL':
    case 'BIGDECIMAL':
      return 'double';
    case 'BOOLEAN':
    case 'BOOL':
      return 'bool';
    case 'DATE':
      return 'date';
    case 'DATETIME':
    case 'TIMESTAMP':
      return 'timestamp';
    default:
      return 'text';
  }
}

/**
 * Turn a real BigQuery column name into a unique, identifier-safe field name
 * (`[A-Za-z][A-Za-z0-9_]*`) so it survives the shared `.tds`/`.hyper` pipeline. Mirrors the
 * Excel connector's sanitizer. Originals are preserved on the field's `name`.
 */
export function toSafeIdentifier(raw: string, used: Set<string>, prefix = 'F'): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(s)) s = prefix + (s ? `_${s}` : '');
  if (!s) s = prefix;
  let candidate = s;
  let n = 2;
  while (used.has(candidate)) candidate = `${s}_${n++}`;
  used.add(candidate);
  return candidate;
}

async function restGet<T>(auth: BigQueryAuth, url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Google: ${redactString(String(err))}`);
  }
  return handleJson<T>(res, url);
}

async function restPost<T>(auth: BigQueryAuth, url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Google: ${redactString(String(err))}`);
  }
  return handleJson<T>(res, url);
}

async function handleJson<T>(res: Response, _url: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 401) {
      throw new AppError('AUTH_FAILED', 'Google session is invalid or expired. Sign in again.');
    }
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) message = String(parsed.error.message);
    } catch {
      /* keep default */
    }
    // The URL carries only project/dataset/table ids (no secrets); log a short preview.
    log.warn('BigQuery REST error', {
      status: res.status,
      contentType: res.headers.get('content-type') ?? undefined,
      bodyPreview: redactString(String(text)).slice(0, 300),
    });
    throw new AppError('CONNECTOR_API', `BigQuery API error (${res.status}): ${redactString(message)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError('CONNECTOR_API', 'Unexpected non-JSON response from Google.');
  }
}

/** List the account's ACTIVE GCP projects (used for both billing-project and data-project pickers). */
export async function listProjects(auth: BigQueryAuth): Promise<BigQueryProject[]> {
  const out: BigQueryProject[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${RESOURCE_MANAGER_BASE}/projects`);
    url.searchParams.set('filter', 'lifecycleState:ACTIVE');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await restGet<{
      projects?: Array<{ projectId?: string; name?: string; lifecycleState?: string }>;
      nextPageToken?: string;
    }>(auth, url.toString());
    for (const p of body.projects ?? []) {
      if (p?.projectId) out.push({ id: String(p.projectId), name: String(p.name ?? p.projectId) });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  out.sort((a, b) => a.name.localeCompare(b.name));
  log.info('Listed BigQuery projects', { count: out.length });
  return out;
}

/** List datasets in a project. */
export async function listDatasets(auth: BigQueryAuth, projectId: string): Promise<BigQueryDataset[]> {
  const safeProject = requireProjectId(projectId);
  const out: BigQueryDataset[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${BIGQUERY_BASE}/projects/${encodeURIComponent(safeProject)}/datasets`);
    url.searchParams.set('all', 'false');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await restGet<{
      datasets?: Array<{ datasetReference?: { datasetId?: string }; location?: string }>;
      nextPageToken?: string;
    }>(auth, url.toString());
    for (const d of body.datasets ?? []) {
      const id = d?.datasetReference?.datasetId;
      if (id) out.push({ id: String(id), location: d.location });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  out.sort((a, b) => a.id.localeCompare(b.id));
  log.info('Listed BigQuery datasets', { project: safeProject, count: out.length });
  return out;
}

/** List tables (and views) in a dataset. */
export async function listTables(auth: BigQueryAuth, projectId: string, datasetId: string): Promise<BigQueryTable[]> {
  const safeProject = requireProjectId(projectId);
  const safeDataset = requireDatasetId(datasetId);
  const out: BigQueryTable[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `${BIGQUERY_BASE}/projects/${encodeURIComponent(safeProject)}/datasets/${encodeURIComponent(safeDataset)}/tables`,
    );
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await restGet<{
      tables?: Array<{ tableReference?: { tableId?: string }; type?: string }>;
      nextPageToken?: string;
    }>(auth, url.toString());
    for (const t of body.tables ?? []) {
      const id = t?.tableReference?.tableId;
      if (id) out.push({ id: String(id), type: t.type });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  out.sort((a, b) => a.id.localeCompare(b.id));
  log.info('Listed BigQuery tables', { project: safeProject, dataset: safeDataset, count: out.length });
  return out;
}

/** Describe a table's scalar columns (nested/repeated fields are skipped). */
export async function describeTable(
  auth: BigQueryAuth,
  projectId: string,
  datasetId: string,
  tableId: string,
): Promise<BigQueryField[]> {
  const safeProject = requireProjectId(projectId);
  const safeDataset = requireDatasetId(datasetId);
  const safeTable = requireTableId(tableId);
  const body = await restGet<{
    schema?: { fields?: Array<{ name?: string; type?: string; mode?: string }> };
  }>(
    auth,
    `${BIGQUERY_BASE}/projects/${encodeURIComponent(safeProject)}/datasets/${encodeURIComponent(
      safeDataset,
    )}/tables/${encodeURIComponent(safeTable)}`,
  );
  const used = new Set<string>();
  const fields: BigQueryField[] = [];
  for (const f of body.schema?.fields ?? []) {
    const name = String(f?.name ?? '').trim();
    if (!name) continue;
    const type = String(f?.type ?? 'STRING').toUpperCase();
    const mode = String(f?.mode ?? 'NULLABLE').toUpperCase();
    // Skip nested records and repeated (array) columns — not representable as a flat column.
    if (mode === 'REPEATED' || type === 'RECORD' || type === 'STRUCT') continue;
    if (!SCALAR_BQ_TYPES.has(type)) continue;
    fields.push({
      name,
      safeName: toSafeIdentifier(name, used),
      type,
      nillable: mode !== 'REQUIRED',
    });
  }
  return fields;
}

/**
 * Query up to `maxRows` rows of a table and return them as arrays aligned to `fields`
 * order, coerced into the string/number/bool forms the Hyper sidecar expects
 * (`scripts/hyper/build_tdsx.py`): dates as `YYYY-MM-DD`, datetimes/timestamps as
 * `YYYY-MM-DDTHH:MM:SS`, numbers as JS numbers, booleans as booleans, everything else as
 * strings; NULLs preserved. `billingProjectId` is the project that runs (and is billed
 * for) the query; `projectId`/`datasetId`/`tableId` locate the data.
 */
export async function queryRows(
  auth: BigQueryAuth,
  input: {
    billingProjectId: string;
    projectId: string;
    datasetId: string;
    tableId: string;
    fields: BigQueryField[];
    maxRows?: number;
  },
): Promise<Array<Array<unknown>>> {
  const billing = requireProjectId(input.billingProjectId);
  const project = requireProjectId(input.projectId);
  const dataset = requireDatasetId(input.datasetId);
  const table = requireTableId(input.tableId);
  const maxRows = input.maxRows ?? 100_000;
  if (input.fields.length === 0) {
    throw new AppError('VALIDATION', 'No BigQuery columns to query.');
  }

  // Backtick-quote every identifier (BigQuery standard SQL); real column names may contain
  // spaces/hyphens. The table is fully qualified `project.dataset.table`.
  const selectList = input.fields.map((f) => '`' + f.name.replace(/`/g, '') + '`').join(', ');
  const fqTable = '`' + `${project}.${dataset}.${table}`.replace(/`/g, '') + '`';
  const sql = `SELECT ${selectList} FROM ${fqTable} LIMIT ${maxRows}`;

  const first = await restPost<QueryResponse>(auth, `${BIGQUERY_BASE}/projects/${encodeURIComponent(billing)}/queries`, {
    query: sql,
    useLegacySql: false,
    maxResults: Math.min(maxRows, 10_000),
    timeoutMs: 60_000,
  });

  const coercers = input.fields.map((f) => rowCoercer(f.type));
  const rows: Array<Array<unknown>> = [];
  const jobId = first.jobReference?.jobId;
  const location = first.jobReference?.location;

  const pushRows = (page: QueryResponse): void => {
    for (const r of page.rows ?? []) {
      if (rows.length >= maxRows) break;
      const cells = r.f ?? [];
      rows.push(coercers.map((coerce, i) => coerce(cells[i]?.v ?? null)));
    }
  };
  pushRows(first);

  // Follow pagination via getQueryResults until done or the row cap is hit.
  let pageToken = first.pageToken;
  while (pageToken && rows.length < maxRows && jobId) {
    const url = new URL(`${BIGQUERY_BASE}/projects/${encodeURIComponent(billing)}/queries/${encodeURIComponent(jobId)}`);
    url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('maxResults', String(Math.min(maxRows - rows.length, 10_000)));
    if (location) url.searchParams.set('location', location);
    const page = await restGet<QueryResponse>(auth, url.toString());
    pushRows(page);
    pageToken = page.pageToken;
  }

  log.info('Queried BigQuery rows', { table, fields: input.fields.length, rows: rows.length });
  return rows;
}

/** A `jobs.query` / `getQueryResults` response (only the parts we read). */
interface QueryResponse {
  jobReference?: { jobId?: string; location?: string };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  pageToken?: string;
  totalRows?: string;
}

/** Build a value coercer for a BigQuery type that yields a Hyper-sidecar-friendly value. */
function rowCoercer(bqType: string): (v: unknown) => unknown {
  const t = (bqType ?? '').toUpperCase();
  return (raw: unknown): unknown => {
    if (raw == null) return null;
    const s = typeof raw === 'string' ? raw : String(raw);
    switch (t) {
      case 'INTEGER':
      case 'INT64': {
        const n = Number(s);
        return Number.isFinite(n) ? Math.trunc(n) : null;
      }
      case 'FLOAT':
      case 'FLOAT64':
      case 'NUMERIC':
      case 'BIGNUMERIC':
      case 'DECIMAL':
      case 'BIGDECIMAL': {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      }
      case 'BOOLEAN':
      case 'BOOL':
        return s === 'true' || s === '1';
      case 'DATE':
        return s.slice(0, 10);
      case 'DATETIME':
        // BigQuery returns 'YYYY-MM-DDTHH:MM:SS' (or with fractional secs); trim to seconds.
        return s.replace(' ', 'T').slice(0, 19);
      case 'TIMESTAMP': {
        // BigQuery returns TIMESTAMP as epoch seconds (float string, e.g. "1.5790842E9").
        const secs = Number(s);
        if (!Number.isFinite(secs)) return s.replace(' ', 'T').slice(0, 19);
        return new Date(secs * 1000).toISOString().slice(0, 19);
      }
      default:
        return s;
    }
  };
}

const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/i; // GCP project ids
const DATASET_RE = /^[A-Za-z0-9_]{1,1024}$/;
const TABLE_RE = /^[A-Za-z0-9_ $-]{1,1024}$/; // table ids are typically identifier-safe

function requireProjectId(v: string): string {
  const s = String(v ?? '').trim();
  if (!PROJECT_RE.test(s)) throw new AppError('VALIDATION', `Invalid BigQuery project id "${v}".`);
  return s;
}
function requireDatasetId(v: string): string {
  const s = String(v ?? '').trim();
  if (!DATASET_RE.test(s)) throw new AppError('VALIDATION', `Invalid BigQuery dataset id "${v}".`);
  return s;
}
function requireTableId(v: string): string {
  const s = String(v ?? '').trim();
  if (!TABLE_RE.test(s)) throw new AppError('VALIDATION', `Invalid BigQuery table id "${v}".`);
  return s;
}
