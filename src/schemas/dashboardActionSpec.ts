import { z } from 'zod';

/**
 * A dashboard ACTION. Currently supports FILTER actions ("use as filter"): selecting
 * (or hovering, or menu-invoking) a mark on a source sheet filters the OTHER sheets on
 * the same dashboard. Modeled on the sample workbook's filter action
 * (`command='tsc:tsl-filter'`).
 */
export const DashboardActionSpecSchema = z.object({
  /**
   * `filter` = a use-as-filter action. `none` is an explicit sentinel meaning the user
   * turned interactivity OFF (so the generator does NOT auto-add the default action).
   */
  type: z.enum(['filter', 'none']).default('filter'),
  /** Caption shown in Tableau (defaults to "Filter on <dashboard>"). */
  caption: z.string().optional(),
  /**
   * When the action runs: `select` = on click (default, auto-clears), `hover` = on
   * hover, `menu` = via the tooltip menu.
   */
  runOn: z.enum(['select', 'hover', 'menu']).default('select'),
  /**
   * Worksheets on this dashboard that should NOT trigger the filter (e.g. KPI cards).
   * KPI sheets are excluded automatically even when this is empty.
   */
  excludeSheets: z.array(z.string()).default([]),
});
export type DashboardActionSpec = z.infer<typeof DashboardActionSpecSchema>;
