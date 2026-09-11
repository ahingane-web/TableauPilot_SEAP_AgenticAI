import { z } from 'zod';
import { CalculatedFieldSpecSchema } from './calculatedFieldSpec.js';
import { DashboardActionSpecSchema } from './dashboardActionSpec.js';
import { DashboardLayoutSpecSchema } from './dashboardLayoutSpec.js';
import { DatasourceReferenceSchema } from './common.js';
import { FilterSpecSchema } from './filterSpec.js';
import { ParameterSpecSchema } from './parameterSpec.js';
import { PublishingSpecSchema } from './publishingSpec.js';
import { WorksheetSpecSchema } from './worksheetSpec.js';

/**
 * One dashboard within the workbook. A workbook can hold SEVERAL dashboards, each
 * arranging a SUBSET of the shared worksheet pool with its own size, appearance, and
 * layout items. It reuses every field of the layout spec and adds a `name` (the tab
 * caption) plus optional per-dashboard `actions` (interactivity) that override the
 * plan-level default for this board only.
 */
export const DashboardSpecSchema = DashboardLayoutSpecSchema.extend({
  name: z.string().min(1),
  actions: z.array(DashboardActionSpecSchema).optional(),
});
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;

/**
 * The complete, structured dashboard plan produced by the agent and validated with
 * Zod before any authoring/publishing. This is the contract between AI *planning*
 * and deterministic *execution* — free-form LLM text is never trusted directly.
 */
export const DashboardPlanSchema = z.object({
  dashboardName: z.string().min(1),
  description: z.string().optional(),
  datasource: DatasourceReferenceSchema,
  worksheets: z.array(WorksheetSpecSchema).min(1),
  filters: z.array(FilterSpecSchema).default([]),
  calculatedFields: z.array(CalculatedFieldSpecSchema).default([]),
  parameters: z.array(ParameterSpecSchema).default([]),
  /**
   * Dashboard actions (interactivity). When omitted, the generator adds a default
   * "use as filter" action so clicking a mark filters the rest of the dashboard.
   */
  actions: z.array(DashboardActionSpecSchema).default([]),
  /**
   * The PRIMARY dashboard's layout. Retained for backward compatibility and always
   * describes the first board. When the user asks for SEVERAL separate dashboards the
   * planner also fills `dashboards[]`; otherwise the generator synthesizes a single
   * board from this `layout` + `dashboardName`.
   */
  layout: DashboardLayoutSpecSchema,
  /**
   * Additional dashboards (each a named board over a subset of worksheets). When
   * non-empty, this ARRAY is authoritative and the generator emits exactly these
   * boards (in order); `layout` is then just the first board's geometry source. When
   * empty, a single board is synthesized from `layout`.
   */
  dashboards: z.array(DashboardSpecSchema).default([]),
  publishing: PublishingSpecSchema,
  /** Human-facing rationale the agent may include; not used for execution. */
  notes: z.string().optional(),
});
export type DashboardPlan = z.infer<typeof DashboardPlanSchema>;

/**
 * The subset the LLM produces. The publishing target (site/project) AND the datasource
 * identity (id/name/siteId/contentUrl) are injected by the server from the approved
 * context + locked datasource, never chosen by the model — this keeps the target-project
 * guard authoritative and stops the model from failing validation on server-owned fields
 * it cannot know (e.g. an empty `datasource.siteId`).
 */
export const DashboardPlanDraftSchema = DashboardPlanSchema.omit({ publishing: true, datasource: true });
export type DashboardPlanDraft = z.infer<typeof DashboardPlanDraftSchema>;
