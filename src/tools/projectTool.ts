import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { requireSessionFromContext } from './context.js';

/** Select the target Tableau Cloud project (publishing destination). */
export const selectProjectTool = createTool({
  id: 'select_target_project',
  description:
    'Set the target Tableau Cloud project where the final workbook will be published. This becomes the approved publishing destination.',
  inputSchema: z.object({ projectId: z.string(), projectName: z.string() }),
  outputSchema: z.object({ selected: z.boolean(), projectName: z.string() }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    const projects = await TableauService.listProjects(session);
    const project = projects.find((p) => p.id === input.projectId);
    if (!project) {
      throw new Error(`Project ${input.projectName} was not found among your accessible projects.`);
    }
    const auth = session.tableauAuth;
    if (!auth) throw new Error('Not connected to Tableau Cloud.');
    TableauService.setProjectContext(session, {
      siteId: auth.siteId,
      projectId: project.id,
      projectName: project.name,
    });
    return { selected: true, projectName: project.name };
  },
});
