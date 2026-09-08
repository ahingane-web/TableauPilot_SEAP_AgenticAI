/**
 * Shared schema primitives used across the dashboard planning types.
 * All AI output is validated against these before any execution happens.
 */
import { z } from 'zod';

/** Supported Tableau visualization types the planner may choose from. */
export const ChartTypeSchema = z.enum([
  'bar',
  'line',
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
]);
export type ChartType = z.infer<typeof ChartTypeSchema>;

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

export const FormattingSpecSchema = z.object({
  numberFormat: z.string().optional(),
  showLabels: z.boolean().optional(),
  colorPalette: z.string().optional(),
  title: z.string().optional(),
});
export type FormattingSpec = z.infer<typeof FormattingSpecSchema>;
