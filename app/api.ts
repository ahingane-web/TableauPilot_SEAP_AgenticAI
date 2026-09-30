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
  // Describe an object's fields (name/label/type) for the relationship builder dropdowns.
  salesforceDescribe: (object: string) =>
    req<{ fields: { name: string; label: string; type: string }[] }>('/api/connectors/salesforce/describe', {
      method: 'POST',
      body: { object },
    }),
  // Build a Salesforce extract datasource (single object, or multiple joined via
  // relationships). Credentials are used only to read the object schema (describe);
  // publishing uses the SAVED Salesforce OAuth credential on Tableau Cloud.
  salesforcePublish: (body: {
    credentials: { url: string; username: string; password: string; token?: string };
    /** One object = single-table; multiple = relationships datasource. */
    tables: string[];
    relationships?: Array<{
      leftObject: string;
      leftField: string;
      rightObject: string;
      rightField: string;
      cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
      joinType?: 'inner' | 'left' | 'right' | 'full';
    }>;
    /** Multi-object data-modeling mode; defaults to 'relationship' server-side. */
    mode?: 'relationship' | 'join';
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

  // ---- Excel connector ----
  // Upload a workbook (multipart). Returns the sheets + per-sheet column identity used by
  // the same relationship/join builder Salesforce uses. Parsed rows stay server-side.
  async excelUpload(file: File): Promise<{
    uploadId: string;
    filename: string;
    sheets: Array<{
      id: string;
      caption: string;
      rowCount: number;
      fields: { name: string; label: string; type: string }[];
    }>;
  }> {
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const sid = getSessionId();
    if (sid) headers['x-session-id'] = sid;
    const res = await fetch('/api/connectors/excel/upload', { method: 'POST', headers, body: form });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ApiError((json.error as SanitizedError) ?? { code: 'INTERNAL', status: res.status, message: 'Upload failed.' });
    }
    return json;
  },
  // Build an Excel extract datasource (single sheet, or sheets joined via relationships).
  // Published EXTRACT-ONLY (the bundled .hyper is the data; no live credential).
  excelPublish: (body: {
    /** One sheet id = single-table; multiple = relationships datasource. */
    sheets: string[];
    relationships?: Array<{
      leftObject: string;
      leftField: string;
      rightObject: string;
      rightField: string;
      cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
      joinType?: 'inner' | 'left' | 'right' | 'full';
    }>;
    mode?: 'relationship' | 'join';
    projectId: string;
    datasourceName: string;
    overwrite?: boolean;
  }) =>
    req<
      SessionContext & {
        datasource: { id: string; name: string; projectName?: string };
        extract: { state: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
      }
    >('/api/connectors/excel/publish', { method: 'POST', body }),

  // ---- BigQuery connector ----
  // Interactive Google OAuth (browser sign-in): start returns the authorize URL to open in a popup.
  bigQueryOauthStart: (body: { clientId?: string; clientSecret?: string } = {}) =>
    req<{ authUrl: string; redirectUri: string }>('/api/connectors/bigquery/oauth/start', { method: 'POST', body }),
  // Read the vault-saved Google OAuth client (non-secret) + whether the server has one via env.
  bigQueryOAuthClientGet: () =>
    req<{ clientId: string; hasSecret: boolean; envConfigured: boolean }>('/api/connectors/bigquery/oauth/client'),
  // Save (or clear) the Google OAuth client id/secret in the user's vault (encrypted at rest).
  bigQueryOAuthClientSave: (body: { clientId: string; clientSecret?: string }) =>
    req<{ saved: boolean; clientId: string; hasSecret: boolean }>('/api/connectors/bigquery/oauth/client', {
      method: 'POST',
      body,
    }),
  // Whether a BigQuery OAuth session is active (polled after the popup completes).
  bigQueryStatus: () => req<{ connected: boolean; email?: string }>('/api/connectors/bigquery/status'),
  // List the signed-in account's GCP projects (billing + data project pickers).
  bigQueryProjects: () =>
    req<{ projects: { id: string; name: string }[] }>('/api/connectors/bigquery/projects'),
  // List datasets in a BigQuery data project.
  bigQueryDatasets: (projectId: string) =>
    req<{ datasets: { id: string; location?: string }[] }>(
      `/api/connectors/bigquery/datasets?projectId=${encodeURIComponent(projectId)}`,
    ),
  // List tables/views in a BigQuery dataset.
  bigQueryTables: (projectId: string, datasetId: string) =>
    req<{ tables: { id: string; type?: string }[] }>(
      `/api/connectors/bigquery/tables?projectId=${encodeURIComponent(projectId)}&datasetId=${encodeURIComponent(datasetId)}`,
    ),
  // Describe a BigQuery table's columns (name/label/type) for the relationship builder.
  bigQueryDescribe: (projectId: string, datasetId: string, table: string) =>
    req<{ fields: { name: string; label: string; type: string }[] }>('/api/connectors/bigquery/describe', {
      method: 'POST',
      body: { projectId, datasetId, table },
    }),
  // Build + publish a BigQuery datasource (single table, or tables joined via relationships/
  // physical join). `materialization` selects a LIVE connection or a materialized extract.
  bigQueryPublish: (body: {
    billingProjectId: string;
    dataProjectId: string;
    dataProjectName: string;
    datasetId: string;
    /** One table id = single-table; multiple = relationships/join datasource. */
    tables: string[];
    relationships?: Array<{
      leftTable: string;
      leftField: string;
      rightTable: string;
      rightField: string;
      cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
      joinType?: 'inner' | 'left' | 'right' | 'full';
    }>;
    mode?: 'relationship' | 'join';
    materialization?: 'live' | 'extract';
    projectId: string;
    datasourceName: string;
    overwrite?: boolean;
  }) =>
    req<
      SessionContext & {
        datasource: { id: string; name: string; projectName?: string };
        extract: { state: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
      }
    >('/api/connectors/bigquery/publish', { method: 'POST', body }),

  // ---- Salesforce Data Cloud connector ----
  dataCloudConnect: (creds: { url: string; username: string; password: string; token?: string }) =>
    req<{ connected: true }>('/api/connectors/datacloud/connect', { method: 'POST', body: creds }),
  dataCloudDataSpaces: () =>
    req<{ dataSpaces: { name: string; label: string }[] }>('/api/connectors/datacloud/dataspaces'),
  dataCloudObjects: (dataSpace: string, category: 'dmo' | 'dlo' | 'ci' | 'all' = 'all') =>
    req<{ objects: { name: string; label: string; category: 'dmo' | 'dlo' | 'ci' }[] }>(
      `/api/connectors/datacloud/objects?dataSpace=${encodeURIComponent(dataSpace)}&category=${encodeURIComponent(category)}`,
    ),
  dataCloudDescribe: (dataSpace: string, object: string) =>
    req<{ fields: { name: string; label: string; type: string }[] }>('/api/connectors/datacloud/describe', {
      method: 'POST',
      body: { dataSpace, object },
    }),
  dataCloudPublish: (body: {
    credentials: { url: string; username: string; password: string; token?: string };
    dataSpace: string;
    category?: 'dmo' | 'dlo' | 'ci' | 'all';
    tables: string[];
    relationships?: Array<{
      leftObject: string;
      leftField: string;
      rightObject: string;
      rightField: string;
      cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
      joinType?: 'inner' | 'left' | 'right' | 'full';
    }>;
    mode?: 'relationship' | 'join';
    materialization?: 'live' | 'extract';
    projectId: string;
    datasourceName: string;
    overwrite?: boolean;
  }) =>
    req<
      SessionContext & {
        datasource: { id: string; name: string; projectName?: string };
        extract: { state: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
      }
    >('/api/connectors/datacloud/publish', { method: 'POST', body }),

  // ---- Snowflake connector ----
  snowflakeConnect: (creds: { url: string; warehouse: string; username: string; password: string }) =>
    req<{ connected: true; warehouse: string; host: string }>('/api/connectors/snowflake/connect', {
      method: 'POST',
      body: creds,
    }),
  snowflakeWarehouses: () =>
    req<{ warehouses: { name: string; label: string }[] }>('/api/connectors/snowflake/warehouses'),
  snowflakeDatabases: (warehouse: string) =>
    req<{ databases: { name: string; label: string }[] }>(
      `/api/connectors/snowflake/databases?warehouse=${encodeURIComponent(warehouse)}`,
    ),
  snowflakeSchemas: (warehouse: string, database: string) =>
    req<{ schemas: { name: string; label: string }[] }>(
      `/api/connectors/snowflake/schemas?warehouse=${encodeURIComponent(warehouse)}&database=${encodeURIComponent(database)}`,
    ),
  snowflakeTables: (warehouse: string, database: string, schema: string) =>
    req<{ tables: { name: string; label: string }[] }>(
      `/api/connectors/snowflake/tables?warehouse=${encodeURIComponent(warehouse)}&database=${encodeURIComponent(database)}&schema=${encodeURIComponent(schema)}`,
    ),
  snowflakeDescribe: (warehouse: string, database: string, schema: string, table: string) =>
    req<{ fields: { name: string; label: string; type: string }[] }>('/api/connectors/snowflake/describe', {
      method: 'POST',
      body: { warehouse, database, schema, table },
    }),
  snowflakePublish: (body: {
    credentials: { url: string; warehouse: string; username: string; password: string };
    warehouse: string;
    database: string;
    schema: string;
    tables: string[];
    relationships?: Array<{
      leftTable: string;
      leftField: string;
      rightTable: string;
      rightField: string;
      cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
      joinType?: 'inner' | 'left' | 'right' | 'full';
    }>;
    mode?: 'relationship' | 'join';
    materialization?: 'live' | 'extract';
    projectId: string;
    datasourceName: string;
    overwrite?: boolean;
  }) =>
    req<
      SessionContext & {
        datasource: { id: string; name: string; projectName?: string };
        extract: { state: 'succeeded' | 'failed' | 'cancelled' | 'pending'; message?: string };
      }
    >('/api/connectors/snowflake/publish', { method: 'POST', body }),

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
