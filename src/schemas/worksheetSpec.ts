import { z } from 'zod';
import {
  AggregationSchema,
  ChartTypeSchema,
  FormattingSpecSchema,
  HexColorSchema,
  NumberFormatKindSchema,
  NumberScaleSchema,
  SortingSpecSchema,
} from './common.js';
import { CalculatedFieldSpecSchema } from './calculatedFieldSpec.js';
import { FilterSpecSchema } from './filterSpec.js';

/** A measure placed on a worksheet, with an optional aggregation + number format. */
export const MeasureRefSchema = z.object({
  field: z.string().min(1),
  aggregation: AggregationSchema.default('sum'),
  /** High-level number format (e.g. currency in millions with 1 decimal). */
  numberFormat: NumberFormatKindSchema.optional(),
  decimalPlaces: z.number().int().min(0).max(10).optional(),
  scale: NumberScaleSchema.optional(),
  currencySymbol: z.string().optional(),
  /**
   * The measure is a calculated field whose formula is ALREADY aggregated
   * (e.g. `SUM([Profit])/SUM([Sales])`); it must not be re-aggregated.
   */
  aggregated: z.boolean().optional(),
});
export type MeasureRef = z.infer<typeof MeasureRefSchema>;

/**
 * A reference / average / constant line drawn against a measure's axis. Aggregate
 * lines (average/median/sum/min/max/total) draw at that aggregate of the measure;
 * `constant` draws at a fixed `value`. Optional fill colors shade the band above/below.
 */
export const ReferenceLineSpecSchema = z.object({
  /** The measure the line is computed against (must be a measure on the viz). */
  field: z.string().min(1),
  aggregation: AggregationSchema.default('sum'),
  formula: z.enum(['average', 'median', 'sum', 'min', 'max', 'total', 'constant']).default('average'),
  /** Only for formula === 'constant'. */
  value: z.number().optional(),
  scope: z.enum(['per-cell', 'per-pane', 'per-table']).default('per-pane'),
  labelType: z.enum(['automatic', 'none', 'value', 'computation']).default('automatic'),
  /** Optional hex band fills above/below the line. */
  fillAbove: HexColorSchema.optional(),
  fillBelow: HexColorSchema.optional(),
});
export type ReferenceLineSpec = z.infer<typeof ReferenceLineSpecSchema>;

/** Per-member color assignments for a dimension shown on the color shelf. */
export const ColorMapSpecSchema = z.object({
  field: z.string().min(1),
  colors: z.array(z.object({ value: z.string().min(1), color: HexColorSchema })).min(1),
});
export type ColorMapSpec = z.infer<typeof ColorMapSpecSchema>;

/** Grand totals: a totals column (row) and/or a totals row (column). */
export const GrandTotalsSchema = z.object({
  row: z.boolean().default(false),
  column: z.boolean().default(false),
});
export type GrandTotals = z.infer<typeof GrandTotalsSchema>;

/**
 * A single worksheet (viz). Every field referenced here is validated against the
 * locked datasource's real metadata before authoring.
 */
export const WorksheetSpecSchema = z.object({
  name: z.string().min(1),
  chartType: ChartTypeSchema,
  /** Dimension field names (categorical / date). */
  dimensions: z.array(z.string()).default([]),
  /** Measures with aggregation. */
  measures: z.array(MeasureRefSchema).default([]),
  filters: z.array(FilterSpecSchema).default([]),
  calculations: z.array(CalculatedFieldSpecSchema).default([]),
  sorting: z.array(SortingSpecSchema).optional(),
  formatting: FormattingSpecSchema.optional(),
  /** Reference / average / constant lines drawn on the viz. */
  referenceLines: z.array(ReferenceLineSpecSchema).optional(),
  /** Grand totals (row totals column / column totals row). */
  grandTotals: GrandTotalsSchema.optional(),
  /** Per-member color palette for the color-encoded dimension. */
  colorMap: ColorMapSpecSchema.optional(),
  /** For KPI tiles: an optional single headline measure. */
  kpiMeasure: MeasureRefSchema.optional(),
  description: z.string().optional(),
});
export type WorksheetSpec = z.infer<typeof WorksheetSpecSchema>;
