// Typed API client. Holds only an opaque session id (never a Tableau/LLM secret).
import type {
  ColorMapView,
  CreationResult,
  CredentialSummary,
  DatasourceMetadataView,
  EmbedInfo,
  FitMode,
  GrandTotalsView,
  NamedItem,
  PlanningResult,
  ReferenceLineView,
  SanitizedError,
  SessionContext,
  TextFormat,
} from './types';

export interface WorksheetFormatOpts {
  name: string;
  referenceLines?: ReferenceLineView[];
  grandTotals?: GrandTotalsView | null;
  colorMap?: ColorMapView | null;
  showLabels?: boolean;
  titleFormat?: TextFormat | null;
  /** Field on the color mark ('' clears it). */
  colorField?: string | null;
  /** Per-sheet fit inside its dashboard zone (null clears to the chart-type default). */
  fit?: FitMode | null;
}

const SID_KEY = 'tp_sid';

let sessionId: string | undefined = localStorage.getItem(SID_KEY) ?? undefined;

export function getSessionId(): string | undefined {
  return sessionId;
}
function setSessionId(id: string | undefined): void {
  sessionId = id;
  if (id) localStorage.setItem(SID_KEY, id);
  else localStorage.removeItem(SID_KEY);
}

export class ApiError extends Error {
  readonly error: SanitizedError;
  constructor(error: SanitizedError) {
    super(error.message);
    this.error = error;
  }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionId) headers['x-session-id'] = sessionId;
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError((json.error as SanitizedError) ?? { code: 'INTERNAL', status: res.status, message: 'Request failed.' });
  }
  return json as T;
}

export interface UnlockResponse {
  sessionId: string;
  username: string;
  hasCredentials: boolean;
  credentialSummary?: CredentialSummary;
}

export const api = {
  health: () => req<{ ok: boolean }>('/api/health'),

  async register(username: string, pin: string): Promise<UnlockResponse> {
    const r = await req<UnlockResponse>('/api/vault/register', { method: 'POST', body: { username, pin } });
    setSessionId(r.sessionId);
    return r;
  },
  async unlock(username: string, pin: string): Promise<UnlockResponse> {
    const r = await req<UnlockResponse>('/api/vault/unlock', { method: 'POST', body: { username, pin } });
    setSessionId(r.sessionId);
    return r;
  },
  async logout(): Promise<void> {
    await req('/api/vault/logout', { method: 'POST' }).catch(() => undefined);
    setSessionId(undefined);
  },
  session: () => req<SessionContext>('/api/vault/session'),
  saveCredentials: (body: unknown) =>
    req<{ saved: boolean; credentialSummary: CredentialSummary }>('/api/vault/credentials', { method: 'POST', body }),
  getCredentials: () =>
    req<{ credentialSummary: CredentialSummary | null }>('/api/vault/credentials'),
  updateCredentials: (body: unknown) =>
    req<{ saved: boolean; credentialSummary: CredentialSummary }>('/api/vault/credentials/update', { method: 'POST', body }),

  connect: () => req<{ connected: boolean; siteContentUrl: string; userId: string }>('/api/tableau/connect', { method: 'POST' }),
  projects: () => req<{ items: NamedItem[] }>('/api/tableau/projects'),
  datasources: () => req<{ items: NamedItem[] }>('/api/tableau/datasources'),
  workbooks: () => req<{ items: NamedItem[] }>('/api/tableau/workbooks'),
  views: () => req<{ items: NamedItem[] }>('/api/tableau/views'),
  metadata: (id: string, name: string) =>
    req<DatasourceMetadataView>(`/api/tableau/datasource/${encodeURIComponent(id)}/metadata?name=${encodeURIComponent(name)}`),
  selectProject: (projectId: string, projectName: string) =>
    req<{ projectContext: SessionContext['projectContext'] }>('/api/tableau/select-project', {
      method: 'POST',
      body: { projectId, projectName },
    }),
  lockDatasource: (datasourceId: string) =>
    req<{ datasourceLock: SessionContext['datasourceLock'] }>('/api/tableau/lock-datasource', {
      method: 'POST',
      body: { datasourceId },
    }),
  unlockDatasource: () => req<{ datasourceLock: null }>('/api/tableau/unlock-datasource', { method: 'POST' }),
  context: () => req<SessionContext>('/api/tableau/context'),

  // ---- Connectors (Build datasource flow) ----
  connectors: () =>
    req<{ items: { id: string; label: string; oauthRedirectUri?: string; oauthConfigured?: boolean }[] }>(
      '/api/connectors',
    ),
  salesforceConnect: (creds: { url: string; username: string; password: string; token?: string }) =>
    req<{ tables: { name: string; label: string }[] }>('/api/connectors/salesforce/connect', { method: 'POST', body: creds }),
  // Interactive OAuth (browser sign-in): start returns the authorize URL to open in a popup.
  salesforceOauthStart: (body: { url: string; clientId?: string; clientSecret?: string }) =>
    req<{ authUrl: string; redirectUri: string }>('/api/connectors/salesforce/oauth/start', { method: 'POST', body }),
  salesforceTables: () =>
    req<{ tables: { name: string; label: string }[] }>('/api/connectors/salesforce/tables'),
  // Build a live Salesforce datasource. Credentials are used only to read the object
  // schema (describe); publishing uses the SAVED Salesforce OAuth credential on Tableau Cloud.
  salesforcePublish: (body: {
    credentials: { url: string; username: string; password: string; token?: string };
    object: string;
    projectId: string;
    datasourceName: string;
    overwrite?: boolean;
    serverOauthCustom?: boolean;
  }) =>
    req<
      SessionContext & {
        datasource: { id: string; name: string; projectName?: string };
        extract: { state: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
      }
    >('/api/connectors/salesforce/publish', { method: 'POST', body }),

  plan: (request: string, workbookName?: string) =>
    req<PlanningResult>('/api/dashboard/plan', { method: 'POST', body: { request, workbookName } }),
  /** Chat: revise the current (unpublished) plan via a natural-language instruction. */
  revisePlan: (instruction: string) =>
    req<PlanningResult>('/api/dashboard/revise', { method: 'POST', body: { instruction } }),
  /** Chat: modify an already-published workbook (revise + republish in place). */
  revisePublished: (instruction: string) =>
    req<CreationResult>('/api/published/revise', { method: 'POST', body: { instruction } }),
  setPublishing: (opts: { workbookName?: string; overwrite?: boolean }) =>
    req<PlanningResult>('/api/dashboard/publishing', { method: 'POST', body: opts }),
  setSize: (opts: {
    size: 'automatic' | 'fixed' | 'range';
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
  }) => req<PlanningResult>('/api/dashboard/size', { method: 'POST', body: opts }),
  setAppearance: (opts: { backgroundColor?: string; containerBackground?: string; titleFormat?: TextFormat | null }) =>
    req<PlanningResult>('/api/dashboard/appearance', { method: 'POST', body: opts }),
  setActions: (opts: { enabled: boolean; runOn?: 'select' | 'hover' | 'menu'; caption?: string; excludeSheets?: string[] }) =>
    req<PlanningResult>('/api/dashboard/actions', { method: 'POST', body: opts }),
  setWorksheetFormat: (opts: WorksheetFormatOpts) =>
    req<PlanningResult>('/api/dashboard/worksheet-format', { method: 'POST', body: opts }),
  approve: (planHash: string) => req<{ approved: boolean; planHash: string }>('/api/dashboard/approve', { method: 'POST', body: { planHash } }),
  execute: () => req<CreationResult>('/api/dashboard/execute', { method: 'POST' }),

  embedInfo: () => req<EmbedInfo>('/api/embed/info'),
};
