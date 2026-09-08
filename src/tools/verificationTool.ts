import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/**
 * Verify a workbook actually exists in Tableau Cloud and resolve its real URL.
 * Used AFTER publishing — success is never reported without this verification.
 */
export const verifyWorkbookTool = createTool({
  id: 'verify_workbook',
  description:
    'Verify a published workbook exists in Tableau Cloud (site/project/views) and return the real, resolved dashboard URL. Never fabricates a URL.',
  inputSchema: z.object({
    workbookId: z.string(),
    expectedProjectId: z.string().optional(),
    dashboardName: z.string().optional(),
  }),
  outputSchema: z.object({
    exists: z.boolean(),
    name: z.string(),
    projectName: z.string().optional(),
    viewCount: z.number(),
    url: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.verify_workbook', { workbookId: input.workbookId }, async () => {
      const v = await TableauService.verify(session, input.workbookId, {
        projectId: input.expectedProjectId,
        dashboardName: input.dashboardName,
      });
      return {
        exists: v.exists,
        name: v.name,
        projectName: v.projectName,
        viewCount: v.views.length,
        url: v.url,
      };
    });
  },
});
