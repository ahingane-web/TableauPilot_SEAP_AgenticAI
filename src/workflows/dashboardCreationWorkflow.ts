/**
 * dashboardCreationWorkflow — the orchestrating Mastra workflow.
 *
 * Flow: validate context -> generate plan -> validate plan -> HUMAN APPROVAL
 * (suspend/resume) -> publish to the approved project -> verify -> return the real
 * URL. The approval gate uses Mastra's suspend/resume so the workflow durably pauses
 * until a human approves.
 *
 * A single `FlowIO` object is threaded through every step (so steps chain cleanly),
 * carrying only NON-secret data (ids, names, status). The heavy lifting is delegated
 * to the shared planning/execution services, which the API server also uses — one
 * source of truth for logic.
 *
 * Note: sessions are in-memory in the process that owns them (the API server). When
 * running this workflow from Mastra Studio (a separate process), provide a sessionId
 * that exists in that process.
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { generateDashboardPlan, approvePlan } from '../planning/index.js';
import { runPublishAndVerify } from '../execution/index.js';
import { TableauService } from '../tableau/index.js';
import { AppError } from '../utils/errors.js';
import { VaultService } from '../vault/vault.js';

const FlowIO = z.object({
  sessionId: z.string(),
  request: z.string(),
  status: z
    .enum(['pending', 'planned', 'invalid', 'approved', 'cancelled', 'completed'])
    .default('pending'),
  planHash: z.string().optional(),
  dashboardName: z.string().optional(),
  validationErrors: z
    .array(z.object({ location: z.string(), field: z.string(), message: z.string() }))
    .optional(),
  message: z.string().optional(),
  result: z
    .object({
      workbookId: z.string(),
      workbookName: z.string(),
      dashboardName: z.string(),
      datasourceName: z.string(),
      projectName: z.string(),
      verified: z.boolean(),
      viewCount: z.number(),
      url: z.string().optional(),
    })
    .optional(),
});
type FlowIOType = z.infer<typeof FlowIO>;

/** Identity helper that contextually types object literals to FlowIOType,
 * preventing string-literal widening of the `status` field. */
const io = (v: FlowIOType): FlowIOType => v;

const validateContext = createStep({
  id: 'validate-context',
  inputSchema: FlowIO,
  outputSchema: FlowIO,
  execute: async ({ inputData, bail }) => {
    const session = VaultService.requireSession(inputData.sessionId);
    if (!TableauService.isConnected(session)) {
      return bail(io({ ...inputData, status: 'invalid', message: 'Not connected to Tableau Cloud.' }));
    }
    if (!session.flow.datasourceLock) {
      return bail(io({ ...inputData, status: 'invalid', message: 'No datasource is locked.' }));
    }
    if (!session.flow.projectContext) {
      return bail(io({ ...inputData, status: 'invalid', message: 'No target project selected.' }));
    }
    return io({ ...inputData, status: 'pending' });
  },
});

const generatePlanStep = createStep({
  id: 'generate-plan',
  inputSchema: FlowIO,
  outputSchema: FlowIO,
  execute: async ({ inputData, bail }) => {
    const session = VaultService.requireSession(inputData.sessionId);
    const { plan, planHash, validation } = await generateDashboardPlan(session, inputData.request);
    if (!validation.valid) {
      return bail(
        io({
          ...inputData,
          status: 'invalid',
          planHash,
          dashboardName: plan.dashboardName,
          validationErrors: validation.errors,
          message: 'The plan references fields that do not exist in the datasource.',
        }),
      );
    }
    return io({ ...inputData, status: 'planned', planHash, dashboardName: plan.dashboardName });
  },
});

const approvalStep = createStep({
  id: 'human-approval',
  inputSchema: FlowIO,
  outputSchema: FlowIO,
  suspendSchema: z.object({
    planHash: z.string(),
    dashboardName: z.string(),
    message: z.string(),
  }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend, bail }) => {
    if (!resumeData) {
      return suspend({
        planHash: inputData.planHash ?? '',
        dashboardName: inputData.dashboardName ?? '',
        message: 'Review the dashboard plan and approve to create & publish it.',
      });
    }
    if (!resumeData.approved) {
      return bail(io({ ...inputData, status: 'cancelled', message: 'Plan was not approved.' }));
    }
    const session = VaultService.requireSession(inputData.sessionId);
    if (!inputData.planHash) throw new AppError('APPROVAL_REQUIRED', 'Missing plan hash for approval.');
    await approvePlan(session, inputData.planHash);
    return io({ ...inputData, status: 'approved' });
  },
});

const executeStep = createStep({
  id: 'publish-and-verify',
  inputSchema: FlowIO,
  outputSchema: FlowIO,
  execute: async ({ inputData }) => {
    const session = VaultService.requireSession(inputData.sessionId);
    const result = await runPublishAndVerify(session);
    return io({
      ...inputData,
      status: 'completed',
      result: {
        workbookId: result.workbookId,
        workbookName: result.workbookName,
        dashboardName: result.dashboardName,
        datasourceName: result.datasourceName,
        projectName: result.projectName,
        verified: result.verified,
        viewCount: result.viewCount,
        url: result.url,
      },
    });
  },
});

export const dashboardCreationWorkflow = createWorkflow({
  id: 'dashboardCreationWorkflow',
  description:
    'Validate context, generate a validated dashboard plan, obtain human approval, publish to the approved project, and verify the real Tableau Cloud result.',
  inputSchema: FlowIO,
  outputSchema: FlowIO,
})
  .then(validateContext)
  .then(generatePlanStep)
  .then(approvalStep)
  .then(executeStep)
  .commit();

export type { FlowIOType };
