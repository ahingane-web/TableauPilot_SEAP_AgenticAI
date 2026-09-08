import { z } from 'zod';
import { FilterOperatorSchema } from './common.js';

/**
 * A filter specification. `field` must reference a real datasource field
 * (validated separately against live metadata). `values` semantics depend on the
 * operator (e.g. `between` uses two values, `top_n` uses [N, byMeasure]).
 */
export const FilterSpecSchema = z.object({
  field: z.string().min(1),
  operator: FilterOperatorSchema,
  values: z.array(z.string()).default([]),
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
