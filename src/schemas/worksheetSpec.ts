import { z } from 'zod';
import {
  AggregationSchema,
  ChartTypeSchema,
  FormattingSpecSchema,
  SortingSpecSchema,
} from './common.js';
import { CalculatedFieldSpecSchema } from './calculatedFieldSpec.js';
import { FilterSpecSchema } from './filterSpec.js';

/** A measure placed on a worksheet, with an optional aggregation. */
export const MeasureRefSchema = z.object({
  field: z.string().min(1),
  aggregation: AggregationSchema.default('sum'),
});
export type MeasureRef = z.infer<typeof MeasureRefSchema>;

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
  /** For KPI tiles: an optional single headline measure. */
  kpiMeasure: MeasureRefSchema.optional(),
  description: z.string().optional(),
});
export type WorksheetSpec = z.infer<typeof WorksheetSpecSchema>;
