/**
 * Dashboard planning service — the bridge between AI *planning* and deterministic
 * *execution*.
 *
 * It asks the agent for a structured DashboardPlan (Zod-enforced), injects the
 * approved publishing target server-side (so the model can't choose a different
 * project), validates every field against live metadata, and stores the plan in
 * session flow state. It NEVER executes authoring — that requires human approval
 * and runs through the guards.
 */
import { RequestContext } from '@mastra/core/request-context';
import { tableauPilotAgent } from '../agents/tableauPilotAgent.js';
import { DashboardPlanDraftSchema, type DashboardPlan } from '../schemas/dashboardPlan.js';
import { TableauService } from '../tableau/index.js';
import type { DatasourceMetadata } from '../tableau/types.js';
import { AppError } from '../utils/errors.js';
import { recordEvent, withSpan } from '../observability/index.js';
import { hashPlan } from '../validation/guards.js';
import { validatePlanFields, type FieldValidationResult } from '../validation/fieldValidation.js';
import type { Session } from '../vault/session.js';

export interface PlanningResult {
  plan: DashboardPlan;
  planHash: string;
  validation: FieldValidationResult;
  metadataApiAvailable: boolean;
}

function fieldSummary(md: DatasourceMetadata): string {
  const list = (fs: { name: string; dataType: string }[]) =>
    fs.length ? fs.map((f) => `${f.name} (${f.dataType})`).join(', ') : '(none)';
  return [
    `Dimensions: ${list(md.dimensions)}`,
    `Measures: ${list(md.measures)}`,
    `Dates: ${list(md.dates)}`,
  ].join('\n');
}

export async function generateDashboardPlan(session: Session, request: string): Promise<PlanningResult> {
  const lock = session.flow.datasourceLock;
  const project = session.flow.projectContext;
  if (!TableauService.isConnected(session)) throw new AppError('AUTH_REQUIRED', 'Connect to Tableau Cloud first.');
  if (!lock) throw new AppError('DATASOURCE_LOCKED', 'Select and lock a datasource before planning.');
  if (!project) throw new AppError('VALIDATION', 'Select a target project before planning.');

  return withSpan('planning.generate', { dashboardRequestChars: request.length }, async () => {
    const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
    if (!metadata.metadataApiAvailable || metadata.fields.length === 0) {
      throw new AppError('TABLEAU_API', 'Could not read datasource fields from the Tableau Metadata API.', {
        hint: 'Ensure the Metadata API is enabled for the site and the datasource has been indexed.',
      });
    }

    const prompt = [
      `Create a dashboard plan for the locked datasource "${lock.datasourceName}".`,
      ``,
      `Use ONLY these real fields (never invent fields):`,
      fieldSummary(metadata),
      ``,
      `User request:`,
      request,
      ``,
      `Produce a DashboardPlan draft: KPIs as single-measure worksheets (chartType "kpi"),`,
      `charts as worksheets with appropriate chartType, filters as requested, calculated fields`,
      `only when their referenced fields exist, and a clean grid layout. The workbook/dashboard`,
      `name should reflect the request.`,
    ].join('\n');

    const requestContext = new RequestContext([['sessionId', session.id]]);
    const result = await tableauPilotAgent.generate(prompt, {
      structuredOutput: { schema: DashboardPlanDraftSchema },
      requestContext,
    });

    const draft = DashboardPlanDraftSchema.parse((result as { object: unknown }).object);

    // Inject the approved publishing target server-side (target-project guard authority).
    const plan: DashboardPlan = {
      ...draft,
      datasource: {
        datasourceId: lock.datasourceId,
        datasourceName: lock.datasourceName,
        siteId: lock.siteId,
        contentUrl: lock.contentUrl,
      },
      publishing: {
        siteId: project.siteId,
        projectId: project.projectId,
        projectName: project.projectName,
        workbookName: draft.dashboardName,
        overwrite: false,
        showTabs: true,
        mode: 'new_workbook',
      },
    };

    const validation = validatePlanFields(plan, metadata);
    session.flow.plan = plan;
    // Any prior approval is invalidated when a new plan is generated.
    session.flow.approvedPlanHash = undefined;
    const planHash = hashPlan(plan);
    recordEvent('plan.generated', {
      dashboard: plan.dashboardName,
      worksheets: plan.worksheets.length,
      valid: validation.valid,
    });
    return { plan, planHash, validation, metadataApiAvailable: metadata.metadataApiAvailable };
  });
}

/** Record human approval for the exact plan currently in session state. */
export function approvePlan(session: Session, expectedHash: string): { approved: boolean; planHash: string } {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'There is no plan to approve.');
  const currentHash = hashPlan(plan);
  if (currentHash !== expectedHash) {
    throw new AppError('APPROVAL_REQUIRED', 'The plan changed since it was shown. Please review the latest plan.');
  }
  session.flow.approvedPlanHash = currentHash;
  recordEvent('plan.approved', { dashboard: plan.dashboardName });
  return { approved: true, planHash: currentHash };
}
