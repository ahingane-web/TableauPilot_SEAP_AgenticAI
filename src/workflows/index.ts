import { dashboardCreationWorkflow } from './dashboardCreationWorkflow.js';
import {
  dashboardAuthoringWorkflow,
  dashboardPlanningWorkflow,
  dashboardValidationWorkflow,
  datasourceLockWorkflow,
  publishingWorkflow,
  tableauConnectionWorkflow,
  tableauDiscoveryWorkflow,
  verificationWorkflow,
} from './phases.js';

export {
  dashboardCreationWorkflow,
  tableauConnectionWorkflow,
  tableauDiscoveryWorkflow,
  datasourceLockWorkflow,
  dashboardPlanningWorkflow,
  dashboardValidationWorkflow,
  dashboardAuthoringWorkflow,
  publishingWorkflow,
  verificationWorkflow,
};

/** All workflows registered with Mastra (visible/runnable in Studio). */
export const workflows = {
  dashboardCreationWorkflow,
  tableauConnectionWorkflow,
  tableauDiscoveryWorkflow,
  datasourceLockWorkflow,
  dashboardPlanningWorkflow,
  dashboardValidationWorkflow,
  dashboardAuthoringWorkflow,
  publishingWorkflow,
  verificationWorkflow,
};
