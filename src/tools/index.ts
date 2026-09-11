/**
 * Mastra tools registry.
 *
 * `agentTools` — read-only discovery + planning + validation tools exposed to the
 * agent. Publishing/verification live in the execution layer (workflows/server) so
 * the LLM never triggers a consequential write directly; the guards still protect
 * those tools if invoked.
 */
import { authenticateTableauTool } from './tableauAuthTool.js';
import { discoverTableauTool } from './tableauDiscoveryTool.js';
import { getDatasourceMetadataTool, lockDatasourceTool } from './datasourceTool.js';
import { selectProjectTool } from './projectTool.js';
import { checkPermissionsTool } from './permissionTool.js';
import { validateDashboardPlanTool } from './authoringTool.js';
import { publishDashboardTool } from './publishingTool.js';
import { verifyWorkbookTool } from './verificationTool.js';
import { designCalculatedFieldsTool } from './calculationTool.js';

export {
  authenticateTableauTool,
  discoverTableauTool,
  getDatasourceMetadataTool,
  lockDatasourceTool,
  selectProjectTool,
  checkPermissionsTool,
  validateDashboardPlanTool,
  publishDashboardTool,
  verifyWorkbookTool,
  designCalculatedFieldsTool,
};

/** Tools the agent may call (read-only + context + validation). */
export const agentTools = {
  authenticate_tableau: authenticateTableauTool,
  discover_tableau_resources: discoverTableauTool,
  get_datasource_metadata: getDatasourceMetadataTool,
  lock_datasource: lockDatasourceTool,
  select_target_project: selectProjectTool,
  check_tableau_permissions: checkPermissionsTool,
  validate_dashboard_plan: validateDashboardPlanTool,
  verify_workbook: verifyWorkbookTool,
  design_calculated_fields: designCalculatedFieldsTool,
};

/** Execution-layer tools (used by workflows/server after approval). */
export const executionTools = {
  publish_dashboard: publishDashboardTool,
  verify_workbook: verifyWorkbookTool,
};
