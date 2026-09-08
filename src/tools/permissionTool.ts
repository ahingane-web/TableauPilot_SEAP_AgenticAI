import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/** Check the user's Tableau permissions for a project, datasource, or workbook. */
export const checkPermissionsTool = createTool({
  id: 'check_tableau_permissions',
  description:
    'Check whether the user has the required Tableau Cloud permissions (publish to a project, use a datasource, or web-edit a workbook) before authoring.',
  inputSchema: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('project'), projectId: z.string(), projectName: z.string() }),
    z.object({ kind: z.literal('datasource'), datasourceId: z.string(), datasourceName: z.string() }),
    z.object({ kind: z.literal('workbook'), workbookId: z.string(), workbookName: z.string() }),
  ]),
  outputSchema: z.object({
    allowed: z.boolean(),
    indeterminate: z.boolean(),
    reason: z.string(),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.check_tableau_permissions', { kind: input.kind }, async () => {
      const auth = session.tableauAuth;
      if (!auth) throw new Error('Not connected to Tableau Cloud.');
      if (input.kind === 'project') {
        const r = await TableauService.checkProjectPublish(session, {
          siteId: auth.siteId,
          projectId: input.projectId,
          projectName: input.projectName,
        });
        return { allowed: r.allowed, indeterminate: r.indeterminate, reason: r.reason };
      }
      if (input.kind === 'datasource') {
        const all = await TableauService.listDatasources(session);
        const ds = all.find((d) => d.id === input.datasourceId);
        if (!ds) throw new Error('Datasource not found.');
        const r = await TableauService.checkDatasourceAccess(session, ds);
        return { allowed: r.allowed, indeterminate: r.indeterminate, reason: r.reason };
      }
      const all = await TableauService.listWorkbooks(session);
      const wb = all.find((w) => w.id === input.workbookId);
      if (!wb) throw new Error('Workbook not found.');
      const r = await TableauService.checkWorkbookEdit(session, wb);
      return { allowed: r.allowed, indeterminate: r.indeterminate, reason: r.reason };
    });
  },
});
