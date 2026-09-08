/**
 * Execution engine — runs ONLY validated, approved operations.
 *
 * This is deliberately separate from planning: the LLM never calls these functions
 * with arbitrary arguments. The server (and the authoring workflow) invoke this
 * after human approval; the guards inside TableauService.publishPlan re-check
 * datasource lock, target project, and approval before anything is written.
 */
import { TableauService } from '../tableau/index.js';
import type { WorkbookVerification } from '../tableau/types.js';
import { AppError } from '../utils/errors.js';
import { recordEvent, withSpan } from '../observability/index.js';
import type { Session } from '../vault/session.js';

export interface CreationResult {
  workbookId: string;
  workbookName: string;
  dashboardName: string;
  datasourceName: string;
  projectName: string;
  published: boolean;
  verified: boolean;
  viewCount: number;
  /** The ACTUAL Tableau Cloud URL resolved from verification — never guessed. */
  url?: string;
  connectedDatasourceIds: string[];
}

export async function runPublishAndVerify(session: Session): Promise<CreationResult> {
  const plan = session.flow.plan;
  const lock = session.flow.datasourceLock;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'No plan present to execute.');
  if (!lock) throw new AppError('DATASOURCE_LOCKED', 'No datasource is locked.');

  return withSpan('execution.publish_and_verify', { dashboard: plan.dashboardName }, async () => {
    const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);

    // Publish (guards enforced inside).
    const publish = await TableauService.publishPlan(session, plan, metadata);
    recordEvent('workbook.published', { workbookId: publish.workbookId });

    // Verify against Tableau Cloud — a 2xx is not proof of success.
    const verification: WorkbookVerification = await TableauService.verify(session, publish.workbookId, {
      projectId: plan.publishing.projectId,
      dashboardName: plan.dashboardName,
    });
    if (!verification.exists) {
      throw new AppError('VERIFICATION_FAILED', 'The workbook could not be verified in Tableau Cloud after publishing.');
    }
    recordEvent('workbook.verified', { workbookId: verification.workbookId, views: verification.views.length });

    return {
      workbookId: verification.workbookId,
      workbookName: verification.name,
      dashboardName: plan.dashboardName,
      datasourceName: lock.datasourceName,
      projectName: verification.projectName ?? plan.publishing.projectName,
      published: true,
      verified: true,
      viewCount: verification.views.length,
      url: verification.url,
      connectedDatasourceIds: verification.connectedDatasourceIds,
    };
  });
}
