/**
 * Shared schema primitives used across the dashboard planning types.
 * All AI output is validated against these before any execution happens.
 */
import { z } from 'zod';

/** Supported Tableau visualization types the planner may choose from. */
export const ChartTypeSchema = z.enum([
  'bar',
  'horizontal_bar',
  'stacked_bar',
  'side_by_side_bar',
  'line',
  'dual_line',
  'area',
  'scatter',
  'pie',
  'donut',
  'text_table',
  'highlight_table',
  'heatmap',
  'treemap',
  'map',
  'symbol_map',
  'filled_map',
  'bullet',
  'histogram',
  'box_plot',
  'gantt',
  'funnel',
  'kpi',
  'dual_axis',
  'bubble',
  'bar_line_combo',
  'detail',
]);
export type ChartType = z.infer<typeof ChartTypeSchema>;

/** Date part / truncation for date dimensions on an axis. */
export const DateDerivationSchema = z.enum([
  'none',
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'weekday',
  'hour',
  'minute',
]);
export type DateDerivation = z.infer<typeof DateDerivationSchema>;

/** High-level number format kind for a measure. */
export const NumberFormatKindSchema = z.enum(['currency', 'percentage', 'number', 'scientific']);
export type NumberFormatKind = z.infer<typeof NumberFormatKindSchema>;

/** Display scaling for a measure (divide by 1e3 / 1e6). */
export const NumberScaleSchema = z.enum(['none', 'thousands', 'millions']);
export type NumberScale = z.infer<typeof NumberScaleSchema>;

/** Filter operators supported by Tableau authoring where reliably achievable. */
export const FilterOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'in',
  'not_in',
  'contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
  'between',
  'null',
  'not_null',
  'top_n',
  'date',
  'relative_date',
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

/** How a field participates in a viz. */
export const FieldRoleSchema = z.enum(['dimension', 'measure']);
export type FieldRole = z.infer<typeof FieldRoleSchema>;

/** Aggregations the planner may request for a measure. */
export const AggregationSchema = z.enum([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_distinct',
  'median',
  'none',
]);
export type Aggregation = z.infer<typeof AggregationSchema>;

/** A reference to the (locked) datasource a plan is built against. */
export const DatasourceReferenceSchema = z.object({
  datasourceId: z.string().min(1),
  datasourceName: z.string().min(1),
  siteId: z.string().min(1),
  /** Optional REST content URL for building deep links. */
  contentUrl: z.string().optional(),
});
export type DatasourceReference = z.infer<typeof DatasourceReferenceSchema>;

/** The user-selected publishing destination. */
export const TableauProjectContextSchema = z.object({
  siteId: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
});
export type TableauProjectContext = z.infer<typeof TableauProjectContextSchema>;

/**
 * Credentials for the Salesforce connector (Build-datasource flow).
 * Secret — validated at the API boundary, kept in memory only, never persisted or logged.
 */
export const SalesforceCredentialsSchema = z.object({
  url: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  token: z.string().optional(),
});
export type SalesforceCredentialsInput = z.infer<typeof SalesforceCredentialsSchema>;

/** A strict lock capturing the single source-of-truth datasource for a session. */
export const DatasourceLockSchema = z.object({
  datasourceId: z.string().min(1),
  datasourceName: z.string().min(1),
  siteId: z.string().min(1),
  contentUrl: z.string().optional(),
  lockedAt: z.string(),
});
export type DatasourceLock = z.infer<typeof DatasourceLockSchema>;

export const SortingSpecSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
  /** Optional: sort by a measure other than the axis field. */
  byField: z.string().optional(),
});
export type SortingSpec = z.infer<typeof SortingSpecSchema>;

/** A 6-digit hex color like `#4e79a7`. */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb hex color');
export type HexColor = z.infer<typeof HexColorSchema>;

/** Optional text formatting for a title/heading (font family, size, color, weight). */
export const TextFormatSchema = z.object({
  fontName: z.string().optional(),
  fontSize: z.number().int().min(6).max(72).optional(),
  fontColor: HexColorSchema.optional(),
  bold: z.boolean().optional(),
});
export type TextFormat = z.infer<typeof TextFormatSchema>;

/**
 * How a worksheet fits inside its dashboard zone — Tableau's per-sheet "Fit" control.
 *  - standard    : the sheet's natural size (scrollable when larger than the zone).
 *  - fit_width   : scale to fill the zone WIDTH.
 *  - fit_height  : scale to fill the zone HEIGHT.
 *  - entire_view : scale the WHOLE viz to fit the zone (Tableau's "Entire View").
 */
export const FitModeSchema = z.enum(['standard', 'fit_width', 'fit_height', 'entire_view']);
export type FitMode = z.infer<typeof FitModeSchema>;

export const FormattingSpecSchema = z.object({
  numberFormat: z.string().optional(),
  showLabels: z.boolean().optional(),
  colorPalette: z.string().optional(),
  title: z.string().optional(),
  /** Font/size/color for the worksheet title (defaults to bold Tableau Bold 12). */
  titleFormat: TextFormatSchema.optional(),
  /** Per-sheet "Fit" inside its dashboard zone. Defaults by chart type when omitted. */
  fit: FitModeSchema.optional(),
  /**
   * Field placed on the COLOR mark (user-selectable before approval). A dimension colors
   * by category (discrete); a measure colors by value (continuous). When omitted, the
   * chart's default color encoding applies.
   */
  colorField: z.string().optional(),
});
export type FormattingSpec = z.infer<typeof FormattingSpecSchema>;
