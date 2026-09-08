/**
 * Deterministic guards enforced OUTSIDE the LLM. These are the hard safety rails
 * the product requires: datasource lock, target-project match, and human approval.
 * The agent can propose; only validated operations that pass these guards execute.
 */
import { createHash } from 'node:crypto';
import type { DashboardPlan } from '../schemas/dashboardPlan.js';
import type { DatasourceLock, TableauProjectContext } from '../schemas/common.js';
import { AppError } from '../utils/errors.js';

/** Stable hash of the executable parts of a plan — used for approval integrity. */
export function hashPlan(plan: DashboardPlan): string {
  const material = JSON.stringify({
    dashboardName: plan.dashboardName,
    datasource: plan.datasource,
    worksheets: plan.worksheets,
    filters: plan.filters,
    calculatedFields: plan.calculatedFields,
    parameters: plan.parameters,
    layout: plan.layout,
    publishing: plan.publishing,
  });
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Datasource guard — the locked datasource is the single source of truth. A plan
 * may only reference the locked datasource; switching is forbidden without an
 * explicit unlock.
 */
export function assertDatasourceLock(lock: DatasourceLock | undefined, plan: DashboardPlan): void {
  if (!lock) {
    throw new AppError('DATASOURCE_LOCKED', 'No datasource is locked. Select and lock a datasource first.');
  }
  if (plan.datasource.datasourceId !== lock.datasourceId) {
    throw new AppError('DATASOURCE_LOCKED', 'The plan references a different datasource than the locked one.', {
      hint: 'The locked datasource is the single source of truth. Unlock explicitly to change it.',
      details: { lockedDatasourceId: lock.datasourceId, planDatasourceId: plan.datasource.datasourceId },
    });
  }
  if (plan.datasource.siteId !== lock.siteId) {
    throw new AppError('DATASOURCE_LOCKED', 'The plan references a datasource on a different site than the lock.');
  }
}

/**
 * Target-project guard — publishing must go to EXACTLY the approved site+project.
 * Never silently publish elsewhere.
 */
export function assertProjectMatch(approved: TableauProjectContext | undefined, plan: DashboardPlan): void {
  if (!approved) {
    throw new AppError('PROJECT_MISMATCH', 'No target project has been selected.');
  }
  if (plan.publishing.siteId !== approved.siteId || plan.publishing.projectId !== approved.projectId) {
    throw new AppError('PROJECT_MISMATCH', 'Publishing destination does not match the approved Tableau Cloud project.', {
      hint: 'Re-approval is required to change the publishing destination.',
      details: {
        approved: { siteId: approved.siteId, projectId: approved.projectId },
        plan: { siteId: plan.publishing.siteId, projectId: plan.publishing.projectId },
      },
    });
  }
}

/** Approval guard — consequential operations require a matching human approval. */
export function assertApproved(approvedHash: string | undefined, plan: DashboardPlan): void {
  if (!approvedHash) {
    throw new AppError('APPROVAL_REQUIRED', 'This operation requires human approval of the dashboard plan.');
  }
  if (approvedHash !== hashPlan(plan)) {
    throw new AppError('APPROVAL_REQUIRED', 'The plan changed since it was approved. Please review and approve again.');
  }
}
