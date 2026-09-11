import { z } from 'zod';
import { AggregationSchema, FilterOperatorSchema } from './common.js';

/**
 * A ranked Top-N / Bottom-N filter. Used when `operator === 'top_n'`: keep the N
 * members of `field` with the highest (or lowest) `byMeasure` aggregate. Prefer a
 * PARAMETER-driven N (`nParameter`) so the user can change N live — the generator
 * always creates a "Top N" parameter for a Top-N filter and wires it here.
 */
export const TopNSpecSchema = z.object({
  /** How many members to keep (also the parameter's initial value). */
  n: z.number().int().positive().default(10),
  /** The measure field to rank by (raw datasource field name). */
  byMeasure: z.string().min(1),
  /** Aggregation used on the ranking measure. */
  measureAggregation: AggregationSchema.default('sum'),
  /** Keep the highest (top) or lowest (bottom) members. */
  direction: z.enum(['top', 'bottom']).default('top'),
  /**
   * Caption of the parameter that drives N (e.g. "Top N"). When set, the filter's
   * count references `[Parameters].[Parameter k]` instead of the literal `n`.
   */
  nParameter: z.string().optional(),
});
export type TopNSpec = z.infer<typeof TopNSpecSchema>;

/**
 * A filter specification. `field` must reference a real datasource field
 * (validated separately against live metadata). `values` semantics depend on the
 * operator; a `top_n` filter carries its ranking config in `topN`.
 */
export const FilterSpecSchema = z.object({
  field: z.string().min(1),
  operator: FilterOperatorSchema,
  values: z.array(z.string()).default([]),
  /** Ranking config, required in practice when `operator === 'top_n'`. */
  topN: TopNSpecSchema.optional(),
  /**
   * Filter scope:
   *  - 'all_worksheets': apply to every applicable worksheet in the dashboard
   *  - 'selected_worksheets': apply only to `worksheets`
   */
  scope: z.enum(['all_worksheets', 'selected_worksheets']).default('all_worksheets'),
  worksheets: z.array(z.string()).optional(),
  /** Whether to surface the filter as an interactive control on the dashboard. */
  showAsControl: z.boolean().default(true),
});
export type FilterSpec = z.infer<typeof FilterSpecSchema>;
