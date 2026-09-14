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

/** Salesforce SObject API name (e.g. `Account`, `My_Object__c`). Constrained to valid identifiers. */
export const SalesforceObjectNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Expected a Salesforce SObject API name, e.g. Account or My_Object__c');

/** Salesforce field API name. Same identifier grammar as an object name. */
export const SalesforceFieldNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Expected a Salesforce field API name, e.g. Id or AccountId');

/**
 * Relationship cardinality between two joined objects. Tableau's relationships model
 * does NOT store a SQL join type; instead the "one" side(s) are marked as unique keys,
 * and Tableau chooses the physical join at query time. This maps a friendly cardinality
 * onto the `unique-key`/`is-db-set-unique-key` end-point flags observed in the reference
 * (`reference/sample_datasource_DataModelling.tds`).
 *   - many-to-one : right side unique (default; e.g. Opportunity -> Account)
 *   - one-to-many : left side unique
 *   - one-to-one  : both sides unique
 *   - many-to-many: neither side unique
 */
export const SalesforceCardinalitySchema = z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']);
export type SalesforceCardinality = z.infer<typeof SalesforceCardinalitySchema>;

/**
 * SQL join type for the PHYSICAL-join mode (`mode: 'join'`). Unlike the relationships
 * model (which uses {@link SalesforceCardinalitySchema}), a physical join emits an actual
 * `<relation type='join' join='...'>` in the `.tds`, so the join type is stored verbatim.
 *   - left  : LEFT OUTER (default; e.g. Opportunity LEFT JOIN Account)
 *   - inner : INNER
 *   - right : RIGHT OUTER
 *   - full  : FULL OUTER
 */
export const SalesforceJoinTypeSchema = z.enum(['inner', 'left', 'right', 'full']);
export type SalesforceJoinType = z.infer<typeof SalesforceJoinTypeSchema>;

/**
 * A single relationship (data-modeling edge) between two objects: a matching field pair
 * plus cardinality (relationship mode) and joinType (join mode). `leftObject`/`rightObject`
 * must both appear in the build's `tables`. `cardinality` is consumed by the relationships
 * model; `joinType` by the physical-join model — the build's `mode` selects which one wins.
 */
export const SalesforceRelationshipSchema = z.object({
  leftObject: SalesforceObjectNameSchema,
  leftField: SalesforceFieldNameSchema,
  rightObject: SalesforceObjectNameSchema,
  rightField: SalesforceFieldNameSchema,
  cardinality: SalesforceCardinalitySchema.default('many-to-many'),
  joinType: SalesforceJoinTypeSchema.default('left'),
});
export type SalesforceRelationship = z.infer<typeof SalesforceRelationshipSchema>;

/**
 * Data-modeling mode for a multi-object build:
 *   - relationship : Tableau's relationships (object-graph) model with cardinality.
 *   - join         : a physical join (`<relation type='join'>`) with a SQL join type.
 * Defaults to `relationship` (matches `reference/sample_datasource_DataModelling.tds`).
 */
export const SalesforceBuildModeSchema = z.enum(['relationship', 'join']);
export type SalesforceBuildMode = z.infer<typeof SalesforceBuildModeSchema>;

/**
 * Payload for building a (optionally multi-object) Salesforce extract datasource.
 * A single-object build sends `tables: [object], relationships: []` and behaves exactly
 * as before. Multi-object builds must provide relationships that connect every table into
 * a single graph (at least `tables.length - 1` edges, all connected).
 */
export const SalesforceBuildSchema = z
  .object({
    credentials: SalesforceCredentialsSchema,
    tables: z.array(SalesforceObjectNameSchema).min(1, 'Select at least one Salesforce object'),
    relationships: z.array(SalesforceRelationshipSchema).default([]),
    mode: SalesforceBuildModeSchema.default('relationship'),
    projectId: z.string().trim().min(1, 'Select a Tableau project/folder to publish into'),
    datasourceName: z.string().trim().min(1, 'Provide a name for the new datasource'),
    overwrite: z.boolean().optional(),
    serverOauthCustom: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const tables = val.tables.map((t) => t.trim());
    const unique = new Set(tables);
    if (unique.size !== tables.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tables'], message: 'Duplicate objects are not allowed.' });
    }
    if (tables.length === 1) {
      if (val.relationships.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships'],
          message: 'A single-object datasource cannot have relationships.',
        });
      }
      return;
    }
    // Multi-object: every relationship endpoint must be a selected table, and the
    // relationships must connect all tables into ONE graph.
    for (const [i, r] of val.relationships.entries()) {
      if (!unique.has(r.leftObject.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships', i, 'leftObject'],
          message: `Relationship references "${r.leftObject}", which is not one of the selected objects.`,
        });
      }
      if (!unique.has(r.rightObject.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships', i, 'rightObject'],
          message: `Relationship references "${r.rightObject}", which is not one of the selected objects.`,
        });
      }
      if (r.leftObject.trim() === r.rightObject.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships', i],
          message: 'A relationship must connect two different objects.',
        });
      }
    }
    if (val.relationships.length < tables.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relationships'],
        message: `Need at least ${tables.length - 1} relationship(s) to connect ${tables.length} objects.`,
      });
      return;
    }
    if (!isConnected(tables, val.relationships)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relationships'],
        message: 'The relationships must connect every object into a single joined model.',
      });
    }
  });
export type SalesforceBuildInput = z.infer<typeof SalesforceBuildSchema>;

/**
 * An identifier-safe Excel sheet/field id. The Excel connector sanitizes every worksheet
 * and column name to this grammar on upload (see `src/excel/excelClient.ts`) so they flow
 * through the SAME deterministic `.tds`/`.hyper` pipeline as Salesforce objects/fields.
 */
export const ExcelIdentifierSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Expected an identifier-safe Excel sheet/field id');

/**
 * Payload for building an Excel EXTRACT datasource from a previously uploaded workbook.
 * `sheets` are identifier-safe sheet ids returned by the upload step. A single-sheet build
 * sends `sheets: [id], relationships: []`; multi-sheet builds must provide relationships
 * that connect every sheet into one graph — identical rules to {@link SalesforceBuildSchema},
 * only the connector (and the absence of credentials) differ. Publishing is extract-only.
 */
export const ExcelBuildSchema = z
  .object({
    sheets: z.array(ExcelIdentifierSchema).min(1, 'Select at least one sheet'),
    relationships: z.array(SalesforceRelationshipSchema).default([]),
    mode: SalesforceBuildModeSchema.default('relationship'),
    projectId: z.string().trim().min(1, 'Select a Tableau project/folder to publish into'),
    datasourceName: z.string().trim().min(1, 'Provide a name for the new datasource'),
    overwrite: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const sheets = val.sheets.map((s) => s.trim());
    const unique = new Set(sheets);
    if (unique.size !== sheets.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sheets'], message: 'Duplicate sheets are not allowed.' });
    }
    if (sheets.length === 1) {
      if (val.relationships.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships'],
          message: 'A single-sheet datasource cannot have relationships.',
        });
      }
      return;
    }
    for (const [i, r] of val.relationships.entries()) {
      if (!unique.has(r.leftObject.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships', i, 'leftObject'],
          message: `Relationship references "${r.leftObject}", which is not one of the selected sheets.`,
        });
      }
      if (!unique.has(r.rightObject.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships', i, 'rightObject'],
          message: `Relationship references "${r.rightObject}", which is not one of the selected sheets.`,
        });
      }
      if (r.leftObject.trim() === r.rightObject.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relationships', i],
          message: 'A relationship must connect two different sheets.',
        });
      }
    }
    if (val.relationships.length < sheets.length - 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relationships'],
        message: `Need at least ${sheets.length - 1} relationship(s) to connect ${sheets.length} sheets.`,
      });
      return;
    }
    if (!isConnected(sheets, val.relationships)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['relationships'],
        message: 'The relationships must connect every sheet into a single joined model.',
      });
    }
  });
export type ExcelBuildInput = z.infer<typeof ExcelBuildSchema>;

/** Union-find connectivity check: do the relationship edges connect all tables? */
function isConnected(tables: string[], relationships: Array<{ leftObject: string; rightObject: string }>): boolean {
  const parent = new Map<string, string>();
  for (const t of tables) parent.set(t, t);
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of relationships) {
    const l = r.leftObject.trim();
    const rt = r.rightObject.trim();
    if (parent.has(l) && parent.has(rt)) union(l, rt);
  }
  const roots = new Set(tables.map((t) => find(t)));
  return roots.size === 1;
}

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
