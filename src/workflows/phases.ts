/**
 * Phase workflows.
 *
 * Each maps to a stage of the product flow and reuses the shared service layer, so
 * the same logic powers both the API server and Mastra Studio. The orchestrating
 * `dashboardCreationWorkflow` composes these phases conceptually; here they are also
 * exposed individually for testing/debugging in Studio.
 */
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { generateDashboardPlan } from '../planning/index.js';
import { runPublishAndVerify } from '../execution/index.js';
import { TableauService } from '../tableau/index.js';
import { validatePlanFields } from '../validation/fieldValidation.js';
import { AppError } from '../utils/errors.js';
import { VaultService } from '../vault/vault.js';

const SessionInput = z.object({ sessionId: z.string() });

// --- Connection ---------------------------------------------------------------
export const tableauConnectionWorkflow = createWorkflow({
  id: 'tableauConnectionWorkflow',
  description: 'Sign in to Tableau Cloud using the vault PAT and report the site/user.',
  inputSchema: SessionInput,
  outputSchema: z.object({ connected: z.boolean(), siteContentUrl: z.string(), userId: z.string() }),
})
  .then(
    createStep({
      id: 'connect',
      inputSchema: SessionInput,
      outputSchema: z.object({ connected: z.boolean(), siteContentUrl: z.string(), userId: z.string() }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const res = await TableauService.connect(session);
        return { connected: true, siteContentUrl: res.siteContentUrl, userId: res.userId };
      },
    }),
  )
  .commit();

// --- Discovery ----------------------------------------------------------------
export const tableauDiscoveryWorkflow = createWorkflow({
  id: 'tableauDiscoveryWorkflow',
  description: 'Discover projects, workbooks, views, and published datasources for the site.',
  inputSchema: SessionInput,
  outputSchema: z.object({
    projects: z.number(),
    workbooks: z.number(),
    views: z.number(),
    datasources: z.number(),
  }),
})
  .then(
    createStep({
      id: 'discover',
      inputSchema: SessionInput,
      outputSchema: z.object({
        projects: z.number(),
        workbooks: z.number(),
        views: z.number(),
        datasources: z.number(),
      }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const [projects, workbooks, views, datasources] = await Promise.all([
          TableauService.listProjects(session),
          TableauService.listWorkbooks(session),
          TableauService.listViews(session),
          TableauService.listDatasources(session),
        ]);
        return {
          projects: projects.length,
          workbooks: workbooks.length,
          views: views.length,
          datasources: datasources.length,
        };
      },
    }),
  )
  .commit();

// --- Datasource lock ----------------------------------------------------------
export const datasourceLockWorkflow = createWorkflow({
  id: 'datasourceLockWorkflow',
  description: 'Lock a published datasource as the single source of truth.',
  inputSchema: z.object({ sessionId: z.string(), datasourceId: z.string() }),
  outputSchema: z.object({ locked: z.boolean(), datasourceName: z.string(), lockedAt: z.string() }),
})
  .then(
    createStep({
      id: 'lock',
      inputSchema: z.object({ sessionId: z.string(), datasourceId: z.string() }),
      outputSchema: z.object({ locked: z.boolean(), datasourceName: z.string(), lockedAt: z.string() }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const ds = (await TableauService.listDatasources(session)).find((d) => d.id === inputData.datasourceId);
        if (!ds) throw new AppError('NOT_FOUND', 'Datasource not found.');
        const lock = TableauService.lockDatasource(session, ds);
        return { locked: true, datasourceName: lock.datasourceName, lockedAt: lock.lockedAt };
      },
    }),
  )
  .commit();

// --- Planning -----------------------------------------------------------------
export const dashboardPlanningWorkflow = createWorkflow({
  id: 'dashboardPlanningWorkflow',
  description: 'Generate a Zod-validated DashboardPlan from a natural-language request.',
  inputSchema: z.object({ sessionId: z.string(), request: z.string() }),
  outputSchema: z.object({
    valid: z.boolean(),
    planHash: z.string(),
    dashboardName: z.string(),
    errorCount: z.number(),
  }),
})
  .then(
    createStep({
      id: 'plan',
      inputSchema: z.object({ sessionId: z.string(), request: z.string() }),
      outputSchema: z.object({
        valid: z.boolean(),
        planHash: z.string(),
        dashboardName: z.string(),
        errorCount: z.number(),
      }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const { plan, planHash, validation } = await generateDashboardPlan(session, inputData.request);
        return {
          valid: validation.valid,
          planHash,
          dashboardName: plan.dashboardName,
          errorCount: validation.errors.length,
        };
      },
    }),
  )
  .commit();

// --- Validation ---------------------------------------------------------------
export const dashboardValidationWorkflow = createWorkflow({
  id: 'dashboardValidationWorkflow',
  description: 'Re-validate the current session plan against live datasource metadata.',
  inputSchema: SessionInput,
  outputSchema: z.object({ valid: z.boolean(), errorCount: z.number() }),
})
  .then(
    createStep({
      id: 'validate',
      inputSchema: SessionInput,
      outputSchema: z.object({ valid: z.boolean(), errorCount: z.number() }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const plan = session.flow.plan;
        const lock = session.flow.datasourceLock;
        if (!plan || !lock) throw new AppError('VALIDATION', 'No plan or datasource lock present.');
        const md = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
        const res = validatePlanFields(plan, md);
        return { valid: res.valid, errorCount: res.errors.length };
      },
    }),
  )
  .commit();

// --- Authoring (embed info) ---------------------------------------------------
export const dashboardAuthoringWorkflow = createWorkflow({
  id: 'dashboardAuthoringWorkflow',
  description: 'Resolve the real Web Authoring embed info (URL + auth mode) for the created workbook.',
  inputSchema: SessionInput,
  outputSchema: z.object({
    hasSrc: z.boolean(),
    requiresInteractiveLogin: z.boolean(),
    hasConnectedAppToken: z.boolean(),
  }),
})
  .then(
    createStep({
      id: 'embed-info',
      inputSchema: SessionInput,
      outputSchema: z.object({
        hasSrc: z.boolean(),
        requiresInteractiveLogin: z.boolean(),
        hasConnectedAppToken: z.boolean(),
      }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const wb = session.flow.workbook;
        const info = TableauService.getEmbedInfo(session, {
          workbook: wb ? { id: wb.workbookId, name: wb.name, webpageUrl: wb.webpageUrl, contentUrl: wb.contentUrl } : undefined,
        });
        return {
          hasSrc: Boolean(info.src),
          requiresInteractiveLogin: info.requiresInteractiveLogin,
          hasConnectedAppToken: Boolean(info.token),
        };
      },
    }),
  )
  .commit();

// --- Publishing ---------------------------------------------------------------
export const publishingWorkflow = createWorkflow({
  id: 'publishingWorkflow',
  description: 'Publish the approved plan to the exact target project and verify it.',
  inputSchema: SessionInput,
  outputSchema: z.object({
    workbookId: z.string(),
    verified: z.boolean(),
    url: z.string().optional(),
  }),
})
  .then(
    createStep({
      id: 'publish-verify',
      inputSchema: SessionInput,
      outputSchema: z.object({ workbookId: z.string(), verified: z.boolean(), url: z.string().optional() }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const res = await runPublishAndVerify(session);
        return { workbookId: res.workbookId, verified: res.verified, url: res.url };
      },
    }),
  )
  .commit();

// --- Verification -------------------------------------------------------------
export const verificationWorkflow = createWorkflow({
  id: 'verificationWorkflow',
  description: 'Verify a workbook exists in Tableau Cloud and resolve its real URL.',
  inputSchema: z.object({ sessionId: z.string(), workbookId: z.string(), dashboardName: z.string().optional() }),
  outputSchema: z.object({
    exists: z.boolean(),
    viewCount: z.number(),
    url: z.string().optional(),
  }),
})
  .then(
    createStep({
      id: 'verify',
      inputSchema: z.object({ sessionId: z.string(), workbookId: z.string(), dashboardName: z.string().optional() }),
      outputSchema: z.object({ exists: z.boolean(), viewCount: z.number(), url: z.string().optional() }),
      execute: async ({ inputData }) => {
        const session = VaultService.requireSession(inputData.sessionId);
        const v = await TableauService.verify(session, inputData.workbookId, { dashboardName: inputData.dashboardName });
        return { exists: v.exists, viewCount: v.views.length, url: v.url };
      },
    }),
  )
  .commit();
