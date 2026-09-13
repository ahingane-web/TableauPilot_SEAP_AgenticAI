/**
 * Minimal Salesforce connector client (pure TypeScript, no external deps).
 *
 * This is the ONLY module that talks to Salesforce. It authenticates with the
 * SOAP `login` call — which needs only a login URL + username + password
 * (+ optional security token) and therefore does NOT require a Connected App /
 * OAuth client id+secret — then uses the REST API for object discovery.
 *
 * Security:
 *  - Credentials (password/token) are never logged. Only sanitized, secret-free
 *    diagnostics are emitted. The session id / access token lives in memory only.
 *  - The caller keeps credentials on the in-memory Session for the duration of a
 *    "Build datasource" flow and discards them afterwards.
 */
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';

const log = logger.child('salesforce');

/** Salesforce API version used for the SOAP login endpoint and REST calls. */
export const SALESFORCE_API_VERSION = '59.0';

/** Raw connector credentials collected from the user. Secret — memory only. */
export interface SalesforceCredentials {
  /** Login URL, e.g. https://login.salesforce.com or a My Domain URL. */
  url: string;
  username: string;
  password: string;
  /** Optional security token, appended to the password for API logins. */
  token?: string;
}

/** A live Salesforce session (result of {@link login}). Access token — memory only. */
export interface SalesforceSession {
  /** Instance origin, e.g. https://mycompany.my.salesforce.com */
  instanceUrl: string;
  /** SOAP session id, used as the REST Bearer token. */
  accessToken: string;
  apiVersion: string;
}

/** A queryable Salesforce object (SObject) the user can turn into a datasource. */
export interface SalesforceTable {
  /** API name, e.g. "Account". */
  name: string;
  /** Human label, e.g. "Account". */
  label: string;
  queryable: boolean;
}

/** A field on a Salesforce object (used for column generation / future joins). */
export interface SalesforceField {
  name: string;
  label: string;
  /** Salesforce soap type, e.g. string, boolean, double, date, datetime, id. */
  type: string;
  /** Whether the field is nullable (maps to `contains-null` in the `.tds` metadata). */
  nillable: boolean;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Normalize a user-supplied login URL to an https origin with no trailing path. */
export function normalizeLoginUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new AppError('VALIDATION', 'A Salesforce login URL is required (e.g. https://login.salesforce.com).');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let origin: string;
  try {
    origin = new URL(withScheme).origin;
  } catch {
    throw new AppError('VALIDATION', 'The Salesforce login URL is not a valid URL.');
  }
  return origin;
}

function firstTagValue(xml: string, tag: string): string | undefined {
  // Match the tag ignoring any namespace prefix (e.g. <sf:sessionId>).
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, 'i');
  return re.exec(xml)?.[1]?.trim();
}

/**
 * Authenticate to Salesforce via the SOAP Partner `login` operation.
 * Returns a session (instance URL + access token) used for subsequent REST calls.
 */
export async function login(creds: SalesforceCredentials): Promise<SalesforceSession> {
  const loginOrigin = normalizeLoginUrl(creds.url);
  const username = String(creds.username ?? '').trim();
  if (!username) throw new AppError('VALIDATION', 'A Salesforce username is required.');
  if (!creds.password) throw new AppError('VALIDATION', 'A Salesforce password is required.');
  // Salesforce API logins require password + security token concatenated (no separator).
  const secret = `${creds.password}${creds.token ?? ''}`;

  const soapBody =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">` +
    `<soapenv:Body>` +
    `<urn:login>` +
    `<urn:username>${xmlEscape(username)}</urn:username>` +
    `<urn:password>${xmlEscape(secret)}</urn:password>` +
    `</urn:login>` +
    `</soapenv:Body>` +
    `</soapenv:Envelope>`;

  const endpoint = `${loginOrigin}/services/Soap/u/${SALESFORCE_API_VERSION}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
      body: soapBody,
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Salesforce: ${redactString(String(err))}`);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const fault = firstTagValue(text, 'faultstring');
    // faultstring can echo the username but never the password; still redact defensively.
    throw new AppError('AUTH_FAILED', `Salesforce login failed: ${redactString(fault ?? `HTTP ${res.status}`)}`, {
      hint: 'Check the login URL, username, password, and security token. Password-based API logins usually require appending your security token.',
    });
  }

  const sessionId = firstTagValue(text, 'sessionId');
  const serverUrl = firstTagValue(text, 'serverUrl');
  if (!sessionId || !serverUrl) {
    throw new AppError('AUTH_FAILED', 'Salesforce login did not return a session. Verify your credentials.');
  }
  let instanceUrl: string;
  try {
    instanceUrl = new URL(serverUrl).origin;
  } catch {
    instanceUrl = loginOrigin;
  }
  log.info('Salesforce login succeeded', { instanceHost: new URL(instanceUrl).host });
  // Salesforce rolls out API versions gradually, so a hardcoded version can 404 on some
  // orgs (e.g. new Developer Edition orgs). Resolve the newest version the org actually
  // serves from the unversioned /services/data/ resource; fall back to the SOAP version.
  const apiVersion = await resolveLatestApiVersion(instanceUrl, sessionId, SALESFORCE_API_VERSION);
  return { instanceUrl, accessToken: sessionId, apiVersion };
}

/**
 * Discover the newest REST API version an org supports by querying the unversioned
 * `/services/data/` resource (which never 404s on version). Best-effort: any failure
 * returns {@link fallback} so login still succeeds.
 */
export async function resolveLatestApiVersion(instanceUrl: string, accessToken: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(`${instanceUrl}/services/data/`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) return fallback;
    const versions = (await res.json()) as Array<{ version?: string }>;
    const numbers = (Array.isArray(versions) ? versions : [])
      .map((v) => Number.parseFloat(String(v?.version ?? '')))
      .filter((n) => Number.isFinite(n));
    if (numbers.length === 0) return fallback;
    const latest = Math.max(...numbers).toFixed(1);
    if (latest !== fallback) {
      log.info('Resolved Salesforce REST API version', { apiVersion: latest });
    }
    return latest;
  } catch {
    return fallback;
  }
}

async function restGet<T>(session: SalesforceSession, path: string): Promise<T> {
  const url = `${session.instanceUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new AppError('CONNECTOR_API', `Network error contacting Salesforce: ${redactString(String(err))}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 401) {
      throw new AppError('AUTH_FAILED', 'Salesforce session is invalid or expired. Reconnect.');
    }
    // Salesforce REST errors are a JSON array [{ message, errorCode }].
    let message = `HTTP ${res.status}`;
    let errorCode: string | undefined;
    try {
      const parsed = JSON.parse(text);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first?.message) message = String(first.message);
      if (first?.errorCode) errorCode = String(first.errorCode);
    } catch {
      /* keep default */
    }
    // Path carries no secrets (api version + object name); log it plus a short body
    // preview to diagnose 404s (e.g. a Salesforce NOT_FOUND vs a proxy/gateway 404).
    log.warn('Salesforce REST error', {
      url,
      status: res.status,
      errorCode,
      contentType: res.headers.get('content-type') ?? undefined,
      bodyPreview: redactString(String(text)).slice(0, 300),
    });
    throw new AppError(
      'CONNECTOR_API',
      `Salesforce API error (${res.status}) on ${path}: ${redactString(message)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError('CONNECTOR_API', 'Unexpected non-JSON response from Salesforce.');
  }
}

/**
 * List the account's queryable Salesforce objects (describeGlobal). Only objects
 * that can back a datasource (queryable) are returned, sorted by label.
 */
export async function listObjects(session: SalesforceSession): Promise<SalesforceTable[]> {
  const body = await restGet<{ sobjects?: Array<{ name?: string; label?: string; queryable?: boolean }> }>(
    session,
    `/services/data/v${session.apiVersion}/sobjects/`,
  );
  const tables = (body.sobjects ?? [])
    .filter((o) => o?.name && o.queryable !== false)
    .map((o) => ({ name: String(o.name), label: String(o.label ?? o.name), queryable: o.queryable !== false }));
  tables.sort((a, b) => a.label.localeCompare(b.label));
  log.info('Listed Salesforce objects', { count: tables.length });
  return tables;
}

/**
 * Salesforce field types that CANNOT be selected in an extract/Bulk query and cause
 * `MALFORMED_QUERY` if included: compound `address`/`location` fields (their scalar
 * component fields — e.g. MailingCity — remain and are kept) and `base64` blobs.
 * Tableau's own connector excludes these too (verified against the reference
 * datasource, which keeps BillingCity but not the BillingAddress compound field).
 */
const NON_EXTRACTABLE_FIELD_TYPES = new Set(['address', 'location', 'base64']);

/** Describe a single Salesforce object's queryable fields (used for datasource columns). */
export async function describeObject(session: SalesforceSession, objectName: string): Promise<SalesforceField[]> {
  const safe = String(objectName ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(safe)) {
    throw new AppError('VALIDATION', 'Invalid Salesforce object name.');
  }
  const body = await restGet<{ fields?: Array<{ name?: string; label?: string; type?: string; nillable?: boolean }> }>(
    session,
    `/services/data/v${session.apiVersion}/sobjects/${safe}/describe/`,
  );
  return (body.fields ?? [])
    .filter((f) => f?.name)
    .filter((f) => !NON_EXTRACTABLE_FIELD_TYPES.has(String(f.type ?? '').toLowerCase()))
    .map((f) => ({
      name: String(f.name),
      label: String(f.label ?? f.name),
      type: String(f.type ?? 'string'),
      // Salesforce describe omits `nillable` for some system fields; default to nullable.
      nillable: f.nillable !== false,
    }));
}

/** A record returned by {@link queryRecords}, minus Salesforce's `attributes` envelope. */
interface QueryResponse {
  done?: boolean;
  nextRecordsUrl?: string;
  records?: Array<Record<string, unknown>>;
}

/**
 * Run a SOQL `SELECT <fields> FROM <object>` and return the rows as arrays aligned to
 * `fieldNames` (so column order matches the extract schema). Follows Salesforce's
 * pagination (`nextRecordsUrl`) until `done`, stopping early at `maxRows`.
 *
 * `fieldNames` must be simple, already-validated API names (compound/blob types are
 * excluded upstream by {@link describeObject}) — they are interpolated into the SOQL,
 * so we defensively validate each again here.
 */
export async function queryRecords(
  session: SalesforceSession,
  objectName: string,
  fieldNames: string[],
  maxRows = 100_000,
): Promise<Array<Array<unknown>>> {
  const safeObject = String(objectName ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(safeObject)) {
    throw new AppError('VALIDATION', 'Invalid Salesforce object name.');
  }
  const safeFields = fieldNames.filter((n) => /^[A-Za-z][A-Za-z0-9_]*$/.test(String(n ?? '')));
  if (safeFields.length === 0) {
    throw new AppError('VALIDATION', 'No valid Salesforce fields to query.');
  }

  const soql = `SELECT ${safeFields.join(', ')} FROM ${safeObject}`;
  let path: string | undefined = `/services/data/v${session.apiVersion}/query?q=${encodeURIComponent(soql)}`;
  const rows: Array<Array<unknown>> = [];

  while (path && rows.length < maxRows) {
    const body: QueryResponse = await restGet<QueryResponse>(session, path);
    for (const record of body.records ?? []) {
      if (rows.length >= maxRows) break;
      // Align each record to the requested field order; missing -> null.
      rows.push(safeFields.map((name) => (record[name] === undefined ? null : record[name])));
    }
    path = body.done === false && body.nextRecordsUrl ? body.nextRecordsUrl : undefined;
  }

  log.info('Queried Salesforce records', { object: safeObject, fields: safeFields.length, rows: rows.length });
  return rows;
}
