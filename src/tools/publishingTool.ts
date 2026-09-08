import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { AppError } from '../utils/errors.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/**
 * Publish the APPROVED plan currently held in session flow state. This is part of
 * the execution layer, not free-form model action: the guards (datasource lock,
 * target-project match, approval hash) run inside TableauService.publishPlan and
 * block anything unapproved. It generates the .twb and uploads it to the exact
 * approved project.
 */
export const publishDashboardTool = createTool({
  id: 'publish_dashboard',
  description:
    'Publish the approved dashboard plan to the exact selected Tableau Cloud project. Enforces datasource lock, project match, and human approval. Returns the created workbook id.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    workbookId: z.string(),
    name: z.string(),
    projectName: z.string().optional(),
    webpageUrl: z.string().optional(),
  }),
  execute: async (_input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.publish_dashboard', {}, async () => {
      const plan = session.flow.plan;
      const lock = session.flow.datasourceLock;
      if (!plan) throw new AppError('APPROVAL_REQUIRED', 'No approved plan is present in the session.');
      if (!lock) throw new AppError('DATASOURCE_LOCKED', 'No datasource is locked.');
      const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
      const result = await TableauService.publishPlan(session, plan, metadata);
      return {
        workbookId: result.workbookId,
        name: result.name,
        projectName: result.projectName,
        webpageUrl: result.webpageUrl,
      };
    });
  },
});
