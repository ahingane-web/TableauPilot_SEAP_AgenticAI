import { z } from 'zod';
import { HexColorSchema, TextFormatSchema } from './common.js';

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
  /**
   * Dashboard sizing mode (asked of the user before publishing):
   *  - 'automatic': fits the browser window (`sizing-mode='automatic'`).
   *  - 'fixed': exact `width` x `height`.
   *  - 'range': scales between (minWidth x minHeight) and (maxWidth x maxHeight).
   */
  size: z.enum(['automatic', 'fixed', 'range']).default('fixed'),
  width: z.number().int().positive().default(1200),
  height: z.number().int().positive().default(800),
  /** Range-mode bounds (used only when size === 'range'). */
  minWidth: z.number().int().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  /** Number of columns in the grid. */
  columns: z.number().int().positive().default(4),
  title: z.string().optional(),
  /** Dashboard background color (behind all zones). Defaults to a light gray. */
  backgroundColor: HexColorSchema.optional(),
  /** Background color for the sheet containers + right panel. Defaults to white. */
  containerBackground: HexColorSchema.optional(),
  /** Font/size/color for the dashboard title band. */
  titleFormat: TextFormatSchema.optional(),
  items: z.array(LayoutItemSchema).default([]),
});
export type DashboardLayoutSpec = z.infer<typeof DashboardLayoutSpecSchema>;
