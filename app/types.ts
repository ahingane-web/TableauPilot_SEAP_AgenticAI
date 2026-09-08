// Client-side mirrors of the non-secret API shapes. No secret ever reaches here.

export interface SanitizedError {
  code: string;
  status: number;
  message: string;
  hint?: string;
  details?: unknown;
}

export interface CredentialSummary {
  cloudUrl: string;
  siteContentUrl: string;
  patName: string;
  hasPatSecret: boolean;
  hasConnectedApp: boolean;
  connectedAppClientId?: string;
}

export interface SessionContext {
  username: string;
  connected: boolean;
  hasCredentials: boolean;
  projectContext: { siteId: string; projectId: string; projectName: string } | null;
  datasourceLock: { datasourceId: string; datasourceName: string; siteId: string; lockedAt: string } | null;
  hasPlan: boolean;
  approved: boolean;
  workbook: { workbookId: string; name: string; webpageUrl?: string; contentUrl?: string } | null;
}

export interface NamedItem {
  id: string;
  name: string;
  projectName?: string;
  contentUrl?: string;
}

export interface FieldInfo {
  name: string;
  dataType: string;
}

export interface DatasourceMetadataView {
  datasourceName: string;
  metadataApiAvailable: boolean;
  dimensions: FieldInfo[];
  measures: FieldInfo[];
  dates: FieldInfo[];
  fieldCount: number;
}

export interface MeasureRef {
  field: string;
  aggregation: string;
}

export interface WorksheetSpecView {
  name: string;
  chartType: string;
  dimensions: string[];
  measures: MeasureRef[];
  filters: { field: string; operator: string; values: string[] }[];
  calculations: { name: string; formula: string }[];
  kpiMeasure?: MeasureRef;
  description?: string;
}

export interface DashboardPlanView {
  dashboardName: string;
  description?: string;
  datasource: { datasourceId: string; datasourceName: string };
  worksheets: WorksheetSpecView[];
  filters: { field: string; operator: string; values: string[] }[];
  calculatedFields: { name: string; formula: string }[];
  parameters: { name: string; dataType: string }[];
  layout: { columns: number; width: number; height: number; items: unknown[] };
  publishing: { projectName: string; workbookName: string };
  notes?: string;
}

export interface FieldValidation {
  valid: boolean;
  errors: { location: string; field: string; message: string }[];
  availableDimensions: string[];
  availableMeasures: string[];
  availableDates: string[];
}

export interface PlanningResult {
  plan: DashboardPlanView;
  planHash: string;
  validation: FieldValidation;
  metadataApiAvailable: boolean;
}

export interface CreationResult {
  workbookId: string;
  workbookName: string;
  dashboardName: string;
  datasourceName: string;
  projectName: string;
  published: boolean;
  verified: boolean;
  viewCount: number;
  url?: string;
  connectedDatasourceIds: string[];
}

export interface EmbedInfo {
  src?: string;
  token?: string;
  tokenExpiresAt?: number;
  requiresInteractiveLogin: boolean;
  embeddingLibraryUrl: string;
}
