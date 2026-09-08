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
      const detail = extractTableauError(text);
      // 401 → session likely expired.
      if (res.status === 401) {
        throw new AppError('AUTH_FAILED', 'Tableau session is invalid or expired.', {
          hint: 'Reconnect to Tableau Cloud.',
          details: { status: res.status, tableau: detail },
        });
      }
      throw new AppError('TABLEAU_API', `Tableau API error (${res.status}): ${detail}`, {
        details: { status: res.status },
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
      // Some endpoints return XML even when JSON is requested; surface a sanitized error.
      throw new AppError('TABLEAU_API', 'Unexpected non-JSON response from Tableau Cloud.');
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

/** Extract a human-readable, secret-free error summary from a Tableau error body. */
function extractTableauError(text: string): string {
  if (!text) return 'no response body';
  try {
    const json = JSON.parse(text);
    const err = json?.error;
    if (err?.detail || err?.summary) {
      return redactString(`${err.summary ?? ''} ${err.detail ?? ''}`.trim());
    }
  } catch {
    // XML fallback
    const summary = /<summary>([^<]*)<\/summary>/i.exec(text)?.[1];
    const detail = /<detail>([^<]*)<\/detail>/i.exec(text)?.[1];
    if (summary || detail) return redactString(`${summary ?? ''} ${detail ?? ''}`.trim());
  }
  return redactString(text.slice(0, 300));
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
