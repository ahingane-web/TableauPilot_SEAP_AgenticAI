import { z } from 'zod';
import { CalculatedFieldSpecSchema } from './calculatedFieldSpec.js';
import { DashboardLayoutSpecSchema } from './dashboardLayoutSpec.js';
import { DatasourceReferenceSchema } from './common.js';
import { FilterSpecSchema } from './filterSpec.js';
import { ParameterSpecSchema } from './parameterSpec.js';
import { PublishingSpecSchema } from './publishingSpec.js';
import { WorksheetSpecSchema } from './worksheetSpec.js';

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
  layout: DashboardLayoutSpecSchema,
  publishing: PublishingSpecSchema,
  /** Human-facing rationale the agent may include; not used for execution. */
  notes: z.string().optional(),
});
export type DashboardPlan = z.infer<typeof DashboardPlanSchema>;

/**
 * The subset the LLM produces. Publishing target (site/project) is injected by the
 * server from the approved context, not chosen by the model — this keeps the target
 * project guard authoritative.
 */
export const DashboardPlanDraftSchema = DashboardPlanSchema.omit({ publishing: true });
export type DashboardPlanDraft = z.infer<typeof DashboardPlanDraftSchema>;
