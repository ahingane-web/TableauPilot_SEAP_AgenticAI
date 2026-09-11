/**
 * Low-level Tableau Cloud REST client.
 *
 * This is the ONLY module that performs raw HTTP against Tableau. Every higher-level
 * concern (discovery, permissions, publishing, verification) goes through a
 * `TableauClient` instance so API calls are not scattered across the codebase.
 *
 * Security:
 *  - The auth token lives on the instance in memory only.
 *  - Errors are sanitized: response bodies are scanned for secret patterns before
 *    being surfaced, and the auth header is never logged.
 */
import { getConfig } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';

const log = logger.child('tableau-client');

export interface SignInInput {
  serverUrl: string;
  siteContentUrl: string;
  patName: string;
  patSecret: string;
}

export interface SignInResult {
  token: string;
  siteId: string;
  siteContentUrl: string;
  userId: string;
}

export interface MultipartPart {
  name: string;
  /** Optional filename (turns the part into a file part). */
  filename?: string;
  contentType: string;
  body: Buffer | string;
}

export class TableauClient {
  readonly serverUrl: string;
  readonly apiVersion: string;
  private token: string | undefined;

  constructor(serverUrl: string, token?: string, apiVersion?: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.apiVersion = apiVersion ?? getConfig().tableau.apiVersion;
    this.token = token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private base(): string {
    return `${this.serverUrl}/api/${this.apiVersion}`;
  }

  /** Sign in with a Personal Access Token; returns and stores the auth token. */
  async signIn(input: SignInInput): Promise<SignInResult> {
    const body = {
      credentials: {
        personalAccessTokenName: input.patName,
        personalAccessTokenSecret: input.patSecret,
        site: { contentUrl: input.siteContentUrl },
      },
    };
    const res = await this.rawFetch(`${this.serverUrl}/api/${this.apiVersion}/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await this.parse(res)) as {
      credentials?: { token?: string; site?: { id?: string; contentUrl?: string }; user?: { id?: string } };
    };
    const creds = json.credentials;
    if (!creds?.token || !creds.site?.id) {
      throw new AppError('AUTH_FAILED', 'Tableau sign-in did not return a session token.');
    }
    this.token = creds.token;
    log.info('Tableau sign-in succeeded', { site: creds.site.contentUrl ?? input.siteContentUrl });
    return {
      token: creds.token,
      siteId: creds.site.id,
      siteContentUrl: creds.site.contentUrl ?? input.siteContentUrl,
      userId: creds.user?.id ?? '',
    };
  }

  async signOut(): Promise<void> {
    if (!this.token) return;
    try {
      await this.rawFetch(`${this.base()}/auth/signout`, {
        method: 'POST',
        headers: this.authHeaders({ Accept: 'application/json' }),
      });
    } catch {
      /* best-effort */
    }
    this.token = undefined;
  }

  /** GET a JSON resource under the current site. */
  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.rawFetch(`${this.base()}${path}`, {
      method: 'GET',
      headers: this.authHeaders({ Accept: 'application/json' }),
    });
    return (await this.parse(res)) as T;
  }

  /**
   * GET raw bytes under the current site (e.g. downloading datasource / workbook
   * `content`). Unlike {@link get}, this does NOT JSON-parse the body — it returns the
   * raw response buffer so callers can unzip a `.tdsx`/`.twbx` or read a `.tds`/`.twb`.
   */
  async getBinary(path: string): Promise<Buffer> {
    // NOTE: Tableau's file-download endpoints (datasource/workbook `content`) reject a
    // narrow Accept like `application/octet-stream` with HTTP 406 Not Acceptable. They
    // negotiate on `*/*` and return the file (XML `.tds`/`.twb` or a `.tdsx`/`.twbx` zip).
    const res = await this.rawFetch(`${this.base()}${path}`, {
      method: 'GET',
      headers: this.authHeaders({ Accept: '*/*' }),
    });
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  }

  /** POST JSON. */
  async postJson<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await this.rawFetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: this.authHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return (await this.parse(res)) as T;
  }

  /** POST to the Metadata API (GraphQL) at /api/metadata/graphql. */
  async metadataGraphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.rawFetch(`${this.serverUrl}/api/metadata/graphql`, {
      method: 'POST',
      headers: this.authHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query, variables }),
    });
    return (await this.parse(res)) as T;
  }

  /** Multipart POST — used for publishing a workbook file. Returns parsed JSON. */
  async postMultipart<T = unknown>(path: string, parts: MultipartPart[]): Promise<T> {
    const boundary = `----tableaupilot${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const body = buildMultipart(parts, boundary);
    const res = await this.rawFetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: this.authHeaders({
        Accept: 'application/json',
        'Content-Type': `multipart/mixed; boundary=${boundary}`,
      }),
      // Node's Buffer is a Uint8Array but its generic form isn't in the DOM BodyInit union.
      body: new Uint8Array(body) as unknown as BodyInit,
    });
    return (await this.parse(res)) as T;
  }

  private authHeaders(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers['X-Tableau-Auth'] = this.token;
    return headers;
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    log.debug('Tableau request', { method: init.method, url: stripQuery(url) });
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new AppError('TABLEAU_API', `Network error contacting Tableau Cloud: ${redactString(String(err))}`);
    }
    if (!res.ok) {
      const text = await safeText(res);
      const { code, message } = extractTableauError(text);
      // Log the raw (redacted, truncated) Tableau error body for diagnostics — the
      // parsed summary/detail sometimes hides useful context (e.g. an internal 500000).
      log.warn('Tableau responded with an error', {
        method: init.method,
        url: stripQuery(url),
        status: res.status,
        tableauCode: code,
        bodyPreview: redactString(text.replace(/\s+/g, ' ').trim().slice(0, 500)),
      });
      // 401 → session likely expired.
      if (res.status === 401) {
        throw new AppError('AUTH_FAILED', 'Tableau session is invalid or expired.', {
          hint: 'Reconnect to Tableau Cloud.',
          details: { status: res.status, tableauCode: code, tableau: message },
        });
      }
      const codeLabel = code ? ` [${code}]` : '';
      throw new AppError('TABLEAU_API', `Tableau API error (${res.status}${codeLabel}): ${message}`, {
        hint: hintForTableauError(res.status, code),
        details: { status: res.status, tableauCode: code },
      });
    }
    return res;
  }

  private async parse(res: Response): Promise<unknown> {
    const text = await safeText(res);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // A 2xx response that isn't JSON is almost always an HTML page (wrong base URL,
      // an SSO/login wall, or a corporate proxy). Surface enough sanitized context to
      // diagnose it without leaking anything sensitive.
      const contentType = res.headers.get('content-type') ?? 'unknown';
      const looksHtml = /<!doctype html|<html[\s>]/i.test(text);
      const hint = looksHtml
        ? 'Tableau returned an HTML page, not the REST API. Check that the Tableau Cloud URL is the base pod URL only — e.g. https://10ax.online.tableau.com — with NO "/#/site/..." path or trailing segments, and that the host is reachable without an SSO/proxy login wall.'
        : 'The endpoint did not return JSON. Verify the Tableau Cloud URL and TABLEAU_API_VERSION.';
      throw new AppError('TABLEAU_API', 'Unexpected non-JSON response from Tableau Cloud.', {
        hint,
        details: {
          requestUrl: stripQuery(res.url),
          status: res.status,
          contentType,
          bodyPreview: redactString(text.replace(/\s+/g, ' ').trim().slice(0, 200)),
        },
      });
    }
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Extract a secret-free error summary AND Tableau's numeric subcode from an error
 * body. The subcode (e.g. 403011, 403026) is the single most useful field for
 * diagnosing publish/permission failures, so we surface it explicitly.
 */
function extractTableauError(text: string): { code?: string; message: string } {
  if (!text) return { message: 'no response body' };
  try {
    const json = JSON.parse(text);
    const err = json?.error;
    if (err && (err.detail || err.summary || err.code)) {
      return {
        code: err.code != null ? String(err.code) : undefined,
        message: redactString(`${err.summary ?? ''} ${err.detail ?? ''}`.trim()) || 'Tableau error',
      };
    }
  } catch {
    // XML fallback: <error code='403011'><summary/><detail/></error>
    const code = /<error[^>]*\bcode=['"]([^'"]+)['"]/i.exec(text)?.[1];
    const summary = /<summary>([^<]*)<\/summary>/i.exec(text)?.[1];
    const detail = /<detail>([^<]*)<\/detail>/i.exec(text)?.[1];
    if (code || summary || detail) {
      return {
        code,
        message: redactString(`${summary ?? ''} ${detail ?? ''}`.trim()) || 'Tableau error',
      };
    }
  }
  return { message: redactString(text.slice(0, 300)) };
}

/** Map common Tableau error subcodes to an actionable, secret-free hint. */
function hintForTableauError(status: number, code?: string): string | undefined {
  if (status !== 403) return undefined;
  switch (code) {
    case '403011':
      return 'Your account lacks Publish permission on the target project. In Tableau Cloud, open the project ▸ Permissions and grant Workbook ▸ Publish (and check for any explicit Deny).';
    case '403130':
      return 'A workbook with this name already exists in the target project. Choose “Overwrite” to replace it, or publish under a different workbook name.';
    case '403026':
      return 'A workbook with this name already exists and is owned by another user, so it cannot be overwritten. Publish under a new name, or take ownership / grant Overwrite on the existing workbook.';
    case '403021':
    case '403004':
      return 'You do not have Connect access to the published datasource this workbook references. Open the datasource ▸ Permissions and grant View + Connect (and check for any explicit Deny). Also confirm the datasource is not in Personal Space.';
    default:
      return 'Tableau denied this action. Check Permissions on the target project (Workbook ▸ Publish) and the published datasource (View + Connect), including any explicit Deny rules; also confirm the datasource is not in Personal Space and does not require prompted credentials.';
  }
}

/** Assemble a multipart/mixed body from parts. */
function buildMultipart(parts: MultipartPart[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  const CRLF = '\r\n';
  for (const part of parts) {
    let header = `--${boundary}${CRLF}`;
    header += part.filename
      ? `Content-Disposition: name="${part.name}"; filename="${part.filename}"${CRLF}`
      : `Content-Disposition: name="${part.name}"${CRLF}`;
    header += `Content-Type: ${part.contentType}${CRLF}${CRLF}`;
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(typeof part.body === 'string' ? Buffer.from(part.body, 'utf8') : part.body);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return Buffer.concat(chunks);
}
