import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { DashboardPlanDraftSchema, type DashboardPlan } from '../schemas/dashboardPlan.js';
import { validatePlanFields } from '../validation/fieldValidation.js';
import { TableauService } from '../tableau/index.js';
import { AppError } from '../utils/errors.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/**
 * Validate a proposed dashboard plan's fields against the LOCKED datasource's live
 * metadata. Returns field errors + the available fields, so the agent (or user) can
 * correct the request before any authoring. This is the "fail early with available
 * fields" safety net.
 */
export const validateDashboardPlanTool = createTool({
  id: 'validate_dashboard_plan',
  description:
    'Validate a dashboard plan against the locked datasource metadata. Confirms every referenced field really exists; returns errors and the list of available dimensions/measures/dates.',
  inputSchema: z.object({ plan: DashboardPlanDraftSchema }),
  outputSchema: z.object({
    valid: z.boolean(),
    errors: z.array(z.object({ location: z.string(), field: z.string(), message: z.string() })),
    availableDimensions: z.array(z.string()),
    availableMeasures: z.array(z.string()),
    availableDates: z.array(z.string()),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.validate_dashboard_plan', { dashboard: input.plan.dashboardName }, async () => {
      const lock = session.flow.datasourceLock;
      if (!lock) throw new AppError('DATASOURCE_LOCKED', 'Lock a datasource before validating a plan.');
      const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
      // Compose a full plan using the approved project as the (guarded) publishing target.
      const project = session.flow.projectContext;
      const fullPlan = {
        ...input.plan,
        publishing: {
          siteId: project?.siteId ?? lock.siteId,
          projectId: project?.projectId ?? '',
          projectName: project?.projectName ?? '',
          workbookName: input.plan.dashboardName,
          overwrite: false,
          showTabs: true,
          mode: 'new_workbook' as const,
        },
      } as DashboardPlan;
      const result = validatePlanFields(fullPlan, metadata);
      return {
        valid: result.valid,
        errors: result.errors,
        availableDimensions: result.availableDimensions,
        availableMeasures: result.availableMeasures,
        availableDates: result.availableDates,
      };
    });
  },
});
