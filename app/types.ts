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
  unavailableReason?: string;
  dimensions: FieldInfo[];
  measures: FieldInfo[];
  dates: FieldInfo[];
  fieldCount: number;
}

export interface MeasureRef {
  field: string;
  aggregation: string;
}

/** Font/size/color for a title or heading. */
export interface TextFormat {
  fontName?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
}

export interface ReferenceLineView {
  field: string;
  aggregation?: string;
  formula: 'average' | 'median' | 'sum' | 'min' | 'max' | 'total' | 'constant';
  value?: number;
  scope?: 'per-cell' | 'per-pane' | 'per-table';
  labelType?: 'automatic' | 'none' | 'value' | 'computation';
  fillAbove?: string;
  fillBelow?: string;
}

export interface ColorMapView {
  field: string;
  colors: { value: string; color: string }[];
}

export interface GrandTotalsView {
  row: boolean;
  column: boolean;
}

export interface WorksheetFormattingView {
  showLabels?: boolean;
  colorPalette?: string;
  title?: string;
  titleFormat?: TextFormat;
  colorField?: string;
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
  formatting?: WorksheetFormattingView;
  referenceLines?: ReferenceLineView[];
  grandTotals?: GrandTotalsView;
  colorMap?: ColorMapView;
}

export interface DashboardActionView {
  type: 'filter' | 'none';
  runOn?: 'select' | 'hover' | 'menu';
  caption?: string;
  excludeSheets?: string[];
}

export interface LayoutItemView {
  worksheet: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  kind?: 'kpi' | 'chart';
}

/** One dashboard (board) within the workbook — a named layout over a subset of sheets. */
export interface DashboardView {
  name: string;
  title?: string;
  size?: 'automatic' | 'fixed' | 'range';
  width?: number;
  height?: number;
  columns?: number;
  backgroundColor?: string;
  containerBackground?: string;
  titleFormat?: TextFormat;
  items: LayoutItemView[];
  actions?: DashboardActionView[];
}

export interface DashboardPlanView {
  dashboardName: string;
  description?: string;
  datasource: { datasourceId: string; datasourceName: string };
  worksheets: WorksheetSpecView[];
  filters: { field: string; operator: string; values: string[] }[];
  calculatedFields: { name: string; formula: string }[];
  parameters: { name: string; dataType: string }[];
  actions?: DashboardActionView[];
  layout: {
    columns: number;
    size?: 'automatic' | 'fixed' | 'range';
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
    backgroundColor?: string;
    containerBackground?: string;
    titleFormat?: TextFormat;
    title?: string;
    items: LayoutItemView[];
  };
  /** Additional named boards. When non-empty, the workbook has one tab per board. */
  dashboards?: DashboardView[];
  publishing: { projectName: string; workbookName: string; overwrite?: boolean };
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
  nameConflict: boolean;
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
