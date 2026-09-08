import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/**
 * Discover Tableau Cloud resources dynamically. Nothing is hardcoded — the lists
 * come from the user's live site. Returns only public metadata (ids/names/urls).
 */
export const discoverTableauTool = createTool({
  id: 'discover_tableau_resources',
  description:
    'List the user\'s accessible Tableau Cloud resources of a given kind: projects, workbooks, views, or published datasources.',
  inputSchema: z.object({
    resource: z.enum(['projects', 'workbooks', 'views', 'datasources']),
  }),
  outputSchema: z.object({
    resource: z.string(),
    count: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        projectName: z.string().optional(),
        contentUrl: z.string().optional(),
      }),
    ),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.discover_tableau_resources', { resource: input.resource }, async () => {
      let items: Array<{ id: string; name: string; projectName?: string; contentUrl?: string }> = [];
      switch (input.resource) {
        case 'projects':
          items = (await TableauService.listProjects(session)).map((p) => ({ id: p.id, name: p.name }));
          break;
        case 'workbooks':
          items = (await TableauService.listWorkbooks(session)).map((w) => ({
            id: w.id,
            name: w.name,
            projectName: w.projectName,
            contentUrl: w.contentUrl,
          }));
          break;
        case 'views':
          items = (await TableauService.listViews(session)).map((v) => ({ id: v.id, name: v.name, contentUrl: v.contentUrl }));
          break;
        case 'datasources':
          items = (await TableauService.listDatasources(session)).map((d) => ({
            id: d.id,
            name: d.name,
            projectName: d.projectName,
            contentUrl: d.contentUrl,
          }));
          break;
      }
      return { resource: input.resource, count: items.length, items };
    });
  },
});
