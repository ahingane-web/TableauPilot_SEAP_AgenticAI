/**
 * Minimal Salesforce Data Cloud (CDP / Genie) connector client (pure TypeScript, no
 * external deps).
 *
 * This is the ONLY module that talks to Data Cloud. It:
 *   1. authenticates via the existing Salesforce SOAP `login` (imported, unmodified),
 *   2. exchanges the core access token for a Data Cloud (CDP) token
 *      (`POST /services/a360/token`),
 *   3. lists data spaces and objects (DMO / DLO / Calculated Insights) and describes
 *      scalar columns,
 *   4. queries rows (to materialize a local `.hyper` extract).
 *
 * It never talks to Tableau. Salesforce CRM HTTP stays in `src/salesforce/*`; this
 * module does not edit that code.
 *
 * Security: credentials, core session, and CDP tokens live in memory only and are
 * never logged. Only sanitized, secret-free diagnostics are emitted.
 */
import { createHash } from 'node:crypto';
import { login as salesforceLogin, type SalesforceCredentials, type SalesforceSession } from '../salesforce/client.js';
import type { HyperColumnType } from '../tableau/authoring/tdsGenerator.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';

const log = logger.child('datacloud');

/** Object category shown in the Data Cloud object-type picker. */
export type DataCloudObjectCategory = 'dmo' | 'dlo' | 'ci' | 'all';

/** A Data Cloud data space (encoded as `warehouse` + `dbname` suffix in the `.tds`). */
export interface DataCloudDataSpace {
  /** API name, e.g. `default`. */
  name: string;
  /** Human label (falls back to `name`). */
  label: string;
}

/** A Data Cloud object (DMO / DLO / Calculated Insight) the user can model. */
export interface DataCloudObject {
  /** Physical/API name, e.g. `ssot__Account__dlm` (used in `[public].[name]`). */
  name: string;
  /** Friendly caption, e.g. `Account` (relation `name` + object-graph caption). */
  label: string;
  category: Exclude<DataCloudObjectCategory, 'all'>;
}

/** A described scalar column. */
export interface DataCloudField {
  /** Real field API name (used as `remote-name` and in SQL). */
  name: string;
  /** Human label (falls back to `name`). */
  label: string;
  /** Data Cloud / ANSI type token, e.g. STRING, NUMBER, DATE, DATETIME, BOOLEAN. */
  type: string;
  nillable: boolean;
}

/** Live Data Cloud session used for REST calls. Secret — memory only. */
export interface DataCloudAuth {
  /** CDP Bearer token (`Authorization: Bearer`). */
  accessToken: string;
  /** Data Cloud query host origin, e.g. `https://xxx.c360a.salesforce.com`. */
  instanceUrl: string;
  /** Core Salesforce instance origin (for Connect REST fallbacks). */
  coreInstanceUrl: string;
  /** Core Salesforce SOAP/REST access token (for `ssot/dataspaces` fallback). Secret. */
  coreAccessToken: string;
  /** Core Salesforce API version (for `ssot/dataspaces` fallback). */
  apiVersion: string;
  /**
   * Data Cloud tenant id (32-hex) used in the `.tds` `dbname`
   * (`a360/{pod}/{tenantId};{dataSpace}`).
   */
  tenantId: string;
  /** Cluster/pod segment of `dbname`, e.g. `prod21`. */
  pod: string;
  /**
   * Data space this CDP token was issued for (Salesforce scopes the a360 token by
   * `dataspace=`). Undefined means the default-space token from connect.
   */
  dataSpace?: string;
}

/** Result of {@link connect}: core Salesforce session + CDP auth. */
export interface DataCloudConnectResult {
  sfSession: SalesforceSession;
  cdp: DataCloudAuth;
}

const OBJECT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;
const DATASPACE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

const NESTED_TYPES = new Set(['STRUCT', 'RECORD', 'ARRAY', 'MAP', 'OBJECT', 'JSON']);

/** Map a Data Cloud field type to the Tableau local datatype family. */
export function dataCloudToTwbType(
  dcType: string,
): 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime' {
  switch ((dcType ?? '').toUpperCase()) {
    case 'INTEGER':
    case 'INT':
    case 'LONG':
    case 'BIGINT':
    case 'NUMBER_INTEGER':
      return 'integer';
    case 'NUMBER':
    case 'DOUBLE':
    case 'FLOAT':
    case 'DECIMAL':
    case 'CURRENCY':
    case 'PERCENT':
    case 'NUMERIC':
      return 'real';
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'DATETIME':
    case 'TIMESTAMP':
    case 'DATE_TIME':
      return 'datetime';
    default:
      return 'string';
  }
}

/** Map a Data Cloud field type to the Hyper extract column category. */
export function dataCloudToHyperType(dcType: string): HyperColumnType {
  switch (dataCloudToTwbType(dcType)) {
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

/** Classify a metadata entity as DMO / DLO / Calculated Insight. */
export function classifyObject(entity: {
  name?: string;
  category?: string;
  type?: string;
  entityType?: string;
  entityCategory?: string;
}): Exclude<DataCloudObjectCategory, 'all'> {
  const name = String(entity.name ?? '').toLowerCase();
  const blob = `${entity.category ?? ''} ${entity.type ?? ''} ${entity.entityType ?? ''} ${entity.entityCategory ?? ''}`.toUpperCase();
  if (name.endsWith('__dll') || blob.includes('DATALAKEOBJECT') || blob.includes('DATA_LAKE') || blob.includes('DATALAKE')) {
    return 'dlo';
  }
  if (
    name.endsWith('__cio') ||
    name.endsWith('__ci') ||
    blob.includes('CALCULATEDINSIGHT') ||
    blob.includes('CALCULATED') ||
    blob.includes('INSIGHT')
  ) {
    return 'ci';
  }
  return 'dmo';
}

/**
 * SOAP-login to Salesforce, then exchange the core token for a Data Cloud (CDP) token.
 * Returns both sessions so the caller can stash them on `session.connectors.datacloud`.
 */
export async function connect(creds: SalesforceCredentials): Promise<DataCloudConnectResult> {
  const sfSession = await salesforceLogin(creds);
  const cdp = await exchangeCdpToken(sfSession);
  log.info('Connected to Salesforce Data Cloud', {
    core: hostOf(sfSession.instanceUrl),
    cdp: hostOf(cdp.instanceUrl),
  });
  return { sfSession, cdp };
}

/**
 * Exchange a core Salesforce access token for a Data Cloud CDP token.
 * Pass `dataSpace` when listing/querying a non-default space — Salesforce scopes the
 * a360 token with the form field `dataspace=`.
 */
export async function exchangeCdpToken(
  sfSession: SalesforceSession,
  dataSpace?: string,
): Promise<DataCloudAuth> {
  const endpoint = `${originOf(sfSession.instanceUrl)}/services/a360/token`;
  const body = new URLSearchParams({
    grant_type: 'urn:salesforce:grant-type:external:cdp',
    subject_token: sfSession.accessToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  });
  const ds = String(dataSpace ?? '').trim();
  if (ds) body.set('dataspace', ds);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Data Cloud: ${redactString(String(err))}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new AppError(
      'CONNECTOR_API',
      `Data Cloud token exchange failed (HTTP ${res.status}). ${hintFromBody(text)}`,
      {
        hint: 'Confirm this Salesforce user has Data Cloud access, then reconnect.',
      },
    );
  }
  let parsed: {
    access_token?: string;
    instance_url?: string;
    expires_in?: number;
    tenant_id?: string;
    tenantId?: string;
    core_tenant_id?: string;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('CONNECTOR_API', 'Unexpected non-JSON response from the Data Cloud token endpoint.');
  }
  if (!parsed.access_token) {
    throw new AppError('AUTH_FAILED', 'Data Cloud did not return an access token.');
  }
  const instanceUrl = String(parsed.instance_url ?? '').replace(/\/+$/, '');
  if (!instanceUrl) {
    throw new AppError('CONNECTOR_API', 'Data Cloud did not return an instance URL.');
  }
  const jwt = decodeJwtPayload(parsed.access_token);
  const normalizedInstance = originOf(instanceUrl);
  const tenantId =
    firstHex32(
      parsed.tenant_id,
      parsed.tenantId,
      parsed.core_tenant_id,
      jwt.tenantId,
      jwt.tenant_id,
      jwt.tid,
      jwt.ctid,
    ) ??
    tenantFromHost(normalizedInstance) ??
    md5Hex32(normalizedInstance);
  const pod = firstPod(jwt.pod, jwt.cluster, jwt.environment, normalizedInstance) ?? 'prod';
  return {
    accessToken: parsed.access_token,
    instanceUrl: normalizedInstance,
    coreInstanceUrl: originOf(sfSession.instanceUrl),
    coreAccessToken: sfSession.accessToken,
    apiVersion: sfSession.apiVersion,
    tenantId,
    pod,
    dataSpace: ds || undefined,
  };
}

/** List data spaces visible to the signed-in Data Cloud user. */
export async function listDataSpaces(auth: DataCloudAuth): Promise<DataCloudDataSpace[]> {
  const fromCdp = await tryJson(auth, `${cdpOrigin(auth)}/api/v1/dataSpaces`);
  let spaces = parseDataSpaces(fromCdp);
  if (spaces.length === 0) {
    const core = originOf(auth.coreInstanceUrl);
    const ver = encodeURIComponent(auth.apiVersion);
    const fallbackUrls = [
      `${core}/services/data/v${ver}/ssot/data-spaces`,
      `${core}/services/data/v${ver}/ssot/dataspaces`,
    ];
    for (const url of fallbackUrls) {
      const fallback = await tryJson(auth, url, { bearerOverride: auth.coreAccessToken });
      spaces = parseDataSpaces(fallback);
      if (spaces.length > 0) break;
    }
  }
  if (spaces.length === 0) {
    throw new AppError(
      'CONNECTOR_API',
      'No Data Cloud data spaces were returned. This user may not have Data Cloud enabled.',
      { hint: 'Confirm Data Cloud is provisioned for this org and the user has access, then reconnect.' },
    );
  }
  log.info('Listed Data Cloud data spaces', { count: spaces.length });
  return spaces;
}

/** List objects in a data space, optionally filtered by category. */
export async function listObjects(
  auth: DataCloudAuth,
  dataSpace: string,
  category: DataCloudObjectCategory = 'all',
): Promise<DataCloudObject[]> {
  const ds = requireDataSpace(dataSpace);
  const entities = await fetchMetadataEntities(auth, ds, { entityType: entityTypeFor(category) });
  const objects: DataCloudObject[] = [];
  for (const e of entities) {
    const name = String(e.name ?? '').trim();
    if (!name || !OBJECT_NAME_RE.test(name)) continue;
    const cat = classifyObject(e);
    if (category !== 'all' && cat !== category) continue;
    const label = String(e.displayName ?? e.label ?? e.caption ?? name).trim() || name;
    objects.push({ name, label, category: cat });
  }
  objects.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  log.info('Listed Data Cloud objects', { dataSpace: ds, category, count: objects.length });
  return objects;
}

/** Describe scalar columns on a Data Cloud object. */
export async function describeObject(
  auth: DataCloudAuth,
  dataSpace: string,
  objectName: string,
): Promise<DataCloudField[]> {
  const ds = requireDataSpace(dataSpace);
  const obj = requireObjectName(objectName);
  let entities = await fetchMetadataEntities(auth, ds, { entityName: obj });
  let entity = entities.find((e) => String(e.name ?? '') === obj);
  if (!entity) {
    entities = await fetchMetadataEntities(auth, ds);
    entity = entities.find((e) => String(e.name ?? '') === obj);
  }
  if (!entity) {
    throw new AppError('NOT_FOUND', `Data Cloud object "${obj}" was not found in data space "${ds}".`);
  }
  const fields: DataCloudField[] = [];
  for (const f of entityColumns(entity)) {
    const name = String(f.name ?? '').trim();
    if (!name || !FIELD_NAME_RE.test(name)) continue;
    const type = String(f.type ?? f.dataType ?? f.businessType ?? 'STRING').trim() || 'STRING';
    if (NESTED_TYPES.has(type.toUpperCase()) || f.repeated === true) continue;
    fields.push({
      name,
      label: String(f.displayName ?? f.label ?? name).trim() || name,
      type,
      nillable: f.nillable !== false && f.nullable !== false,
    });
  }
  if (fields.length === 0) {
    throw new AppError('CONNECTOR_API', `Data Cloud object "${obj}" exposes no scalar columns to model.`);
  }
  return fields;
}

/**
 * Query rows for an extract. Returns arrays aligned to `fields` order with Hyper-sidecar
 * value formats (date `YYYY-MM-DD`, timestamp `YYYY-MM-DDTHH:MM:SS`).
 */
export async function queryRows(
  auth: DataCloudAuth,
  input: {
    dataSpace: string;
    objectName: string;
    fields: DataCloudField[];
    maxRows?: number;
  },
): Promise<Array<Array<unknown>>> {
  const ds = requireDataSpace(input.dataSpace);
  const obj = requireObjectName(input.objectName);
  const maxRows = input.maxRows ?? 100_000;
  if (input.fields.length === 0) {
    throw new AppError('VALIDATION', 'No Data Cloud columns to query.');
  }
  const selectList = input.fields.map((f) => quoteIdent(f.name)).join(', ');
  const sql = `SELECT ${selectList} FROM ${quoteIdent(obj)} LIMIT ${maxRows}`;
  const coercers = input.fields.map((f) => rowCoercer(f.type));

  const payload = { sql };
  const dsHeader = ds;
  const first =
    (await tryPostJson(auth, `${cdpOrigin(auth)}/api/v2/query`, payload, dsHeader)) ??
    (await tryPostJson(auth, `${cdpOrigin(auth)}/api/v1/query`, payload, dsHeader));
  if (!first) {
    throw new AppError('CONNECTOR_API', `Could not query Data Cloud object "${obj}".`, {
      hint: 'Confirm Query API access for this data space.',
    });
  }

  const rows: Array<Array<unknown>> = [];
  const pushPage = (page: QueryPage): void => {
    for (const raw of page.data ?? []) {
      if (rows.length >= maxRows) break;
      rows.push(coerceRow(raw, input.fields, coercers));
    }
  };
  pushPage(parseQueryPage(first));

  let next = first as QueryPageRaw;
  while (rows.length < maxRows && next.nextBatchId) {
    const batchId = encodeURIComponent(String(next.nextBatchId));
    const pageJson =
      (await tryJson(auth, `${cdpOrigin(auth)}/api/v2/query/${batchId}`, { dataSpace: ds })) ??
      (await tryJson(auth, `${cdpOrigin(auth)}/api/v1/query/${batchId}`, { dataSpace: ds }));
    if (!pageJson) break;
    const page = parseQueryPage(pageJson);
    pushPage(page);
    next = pageJson as QueryPageRaw;
    if (page.done || !next.nextBatchId) break;
  }

  log.info('Queried Data Cloud rows', { object: obj, fields: input.fields.length, rows: rows.length });
  return rows;
}

// --- internals ----------------------------------------------------------------------------

function cdpOrigin(auth: DataCloudAuth): string {
  return originOf(auth.instanceUrl);
}

function requireDataSpace(raw: string): string {
  const v = String(raw ?? '').trim();
  if (!DATASPACE_RE.test(v)) {
    throw new AppError('VALIDATION', `Invalid Data Cloud data space "${redactString(v)}".`);
  }
  return v;
}

function requireObjectName(raw: string): string {
  const v = String(raw ?? '').trim();
  if (!OBJECT_NAME_RE.test(v)) {
    throw new AppError('VALIDATION', `Invalid Data Cloud object name "${redactString(v)}".`);
  }
  return v;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '')}"`;
}

function originOf(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function hostOf(url: string): string {
  try {
    return new URL(originOf(url) || url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function hintFromBody(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error_description ?? parsed?.error ?? parsed?.message ?? parsed?.[0]?.message;
    if (msg) return redactString(String(msg));
  } catch {
    /* ignore */
  }
  return '';
}

function decodeJwtPayload(token: string): Record<string, string | undefined> {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

function firstHex32(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const m = String(v ?? '').match(/[a-fA-F0-9]{32}/);
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

function tenantFromHost(instanceUrl: string): string | undefined {
  try {
    const host = new URL(instanceUrl).hostname; // e.g. g8zw8yl0grrdqzb-mftdk9brg4.c360a.salesforce.com
    const sub = host.split('.')[0] ?? '';
    const hex = sub.replace(/-/g, '');
    if (/^[a-fA-F0-9]{32}$/.test(hex)) return hex.toLowerCase();
  } catch {
    /* ignore */
  }
  return undefined;
}

function firstPod(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const m = String(v ?? '').match(/prod\d+/i);
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

function md5Hex32(seed: string): string {
  return createHash('md5').update(seed).digest('hex');
}

function entityTypeFor(category: DataCloudObjectCategory): string | undefined {
  if (category === 'dmo') return 'DataModelObject';
  if (category === 'dlo') return 'DataLakeObject';
  if (category === 'ci') return 'CalculatedInsight';
  return undefined;
}

type MetadataColumn = NonNullable<MetadataEntity['fields']>[number];

function entityColumns(entity: MetadataEntity): MetadataColumn[] {
  return [...(entity.fields ?? []), ...(entity.dimensions ?? []), ...(entity.measures ?? [])];
}

async function fetchMetadataEntities(
  auth: DataCloudAuth,
  dataSpace: string,
  opts?: { entityName?: string; entityType?: string },
): Promise<MetadataEntity[]> {
  const origin = cdpOrigin(auth);
  const qs = new URLSearchParams();
  if (opts?.entityName) qs.set('entityName', opts.entityName);
  if (opts?.entityType) qs.set('entityType', opts.entityType);
  const query = qs.toString();
  const urls = [
    `${origin}/api/v1/metadata/${query ? `?${query}` : ''}`,
    `${origin}/api/v1/metadata${query ? `?${query}` : ''}`,
    `${origin}/api/v1/metadata`,
  ];
  for (const url of urls) {
    const json = await tryJson(auth, url, { dataSpace });
    const entities = parseMetadataEntities(json);
    if (entities.length > 0) return entities;
  }
  throw new AppError(
    'CONNECTOR_API',
    `Could not list Data Cloud metadata in data space "${dataSpace}".`,
    { hint: 'Confirm Data Cloud Metadata API access for this user and data space.' },
  );
}

function parseDataSpaces(json: unknown): DataCloudDataSpace[] {
  if (!json) return [];
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { dataSpaces?: unknown }).dataSpaces)
      ? ((json as { dataSpaces: unknown[] }).dataSpaces)
      : Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : Array.isArray((json as { records?: unknown }).records)
          ? ((json as { records: unknown[] }).records)
          : [];
  const out: DataCloudDataSpace[] = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const name = String(r.name ?? r.dataSpaceName ?? r.id ?? '').trim();
    if (!name || !DATASPACE_RE.test(name)) continue;
    out.push({ name, label: String(r.label ?? r.displayName ?? name).trim() || name });
  }
  return out;
}

interface MetadataEntity {
  name?: string;
  displayName?: string;
  label?: string;
  caption?: string;
  category?: string;
  type?: string;
  entityType?: string;
  entityCategory?: string;
  fields?: Array<{
    name?: string;
    displayName?: string;
    label?: string;
    type?: string;
    dataType?: string;
    businessType?: string;
    nillable?: boolean;
    nullable?: boolean;
    repeated?: boolean;
  }>;
  /** Calculated Insights expose dimensions/measures instead of (or in addition to) fields. */
  dimensions?: MetadataEntity['fields'];
  measures?: MetadataEntity['fields'];
}

function parseMetadataEntities(json: unknown): MetadataEntity[] {
  if (!json) return [];
  if (Array.isArray(json)) return json as MetadataEntity[];
  const obj = json as { metadata?: unknown; data?: unknown; entities?: unknown };
  if (Array.isArray(obj.metadata)) return obj.metadata as MetadataEntity[];
  if (Array.isArray(obj.entities)) return obj.entities as MetadataEntity[];
  if (Array.isArray(obj.data)) return obj.data as MetadataEntity[];
  return [];
}

interface QueryPageRaw {
  data?: unknown[];
  done?: boolean;
  queryId?: string;
  nextBatchId?: string;
}
interface QueryPage {
  data: unknown[];
  done?: boolean;
}

function parseQueryPage(json: unknown): QueryPage {
  const raw = (json ?? {}) as QueryPageRaw;
  return { data: Array.isArray(raw.data) ? raw.data : [], done: raw.done };
}

function coerceRow(
  raw: unknown,
  fields: DataCloudField[],
  coercers: Array<(v: unknown) => unknown>,
): Array<unknown> {
  if (Array.isArray(raw)) {
    return coercers.map((c, i) => c(raw[i] ?? null));
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    return fields.map((f, i) => coercers[i]!(rec[f.name] ?? null));
  }
  return coercers.map((c) => c(null));
}

function rowCoercer(dcType: string): (v: unknown) => unknown {
  const twb = dataCloudToTwbType(dcType);
  return (raw: unknown): unknown => {
    if (raw == null) return null;
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
        return s === 'true' || s === '1';
      case 'date':
        return s.slice(0, 10);
      case 'datetime':
        return s.replace(' ', 'T').slice(0, 19);
      default:
        return s;
    }
  };
}

async function tryJson(
  auth: DataCloudAuth,
  url: string,
  opts?: { bearerOverride?: string; dataSpace?: string },
): Promise<unknown | undefined> {
  const bearer = opts?.bearerOverride ?? auth.accessToken;
  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, Accept: 'application/json' };
  const ds = opts?.dataSpace ?? auth.dataSpace;
  if (ds) headers.dataspace = ds;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function tryPostJson(
  auth: DataCloudAuth,
  url: string,
  body: unknown,
  dataSpace?: string,
): Promise<unknown | undefined> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const ds = dataSpace ?? auth.dataSpace;
  if (ds) headers.dataspace = ds;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
