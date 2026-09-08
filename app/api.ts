// Typed API client. Holds only an opaque session id (never a Tableau/LLM secret).
import type {
  CreationResult,
  CredentialSummary,
  DatasourceMetadataView,
  EmbedInfo,
  NamedItem,
  PlanningResult,
  SanitizedError,
  SessionContext,
} from './types';

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

  plan: (request: string) => req<PlanningResult>('/api/dashboard/plan', { method: 'POST', body: { request } }),
  approve: (planHash: string) => req<{ approved: boolean; planHash: string }>('/api/dashboard/approve', { method: 'POST', body: { planHash } }),
  execute: () => req<CreationResult>('/api/dashboard/execute', { method: 'POST' }),

  embedInfo: (mode: 'new_workbook' | 'existing_workbook') =>
    req<EmbedInfo>(`/api/embed/info?mode=${mode}`),
};
