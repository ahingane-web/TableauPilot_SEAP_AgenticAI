import { z } from 'zod';

/**
 * Dashboard layout. A simple row/column grid the .twb generator maps to zones.
 * Each placement references a worksheet by name and a grid position.
 */
export const LayoutItemSchema = z.object({
  worksheet: z.string().min(1),
  /** Zero-based grid coordinates. */
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive().default(1),
  colSpan: z.number().int().positive().default(1),
  kind: z.enum(['kpi', 'chart']).default('chart'),
});
export type LayoutItem = z.infer<typeof LayoutItemSchema>;

export const DashboardLayoutSpecSchema = z.object({
  /** Overall dashboard size preset. */
  size: z.enum(['desktop', 'default', 'automatic']).default('desktop'),
  width: z.number().int().positive().default(1200),
  height: z.number().int().positive().default(800),
  /** Number of columns in the grid. */
  columns: z.number().int().positive().default(4),
  title: z.string().optional(),
  items: z.array(LayoutItemSchema).default([]),
});
export type DashboardLayoutSpec = z.infer<typeof DashboardLayoutSpecSchema>;
