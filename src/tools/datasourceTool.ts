import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/** Retrieve real field metadata for a published datasource (dimensions/measures/dates). */
export const getDatasourceMetadataTool = createTool({
  id: 'get_datasource_metadata',
  description:
    'Retrieve the real fields of a published datasource from Tableau Cloud (via the Metadata API), grouped into dimensions, measures, and dates. Use ONLY these fields when planning — never invent fields.',
  inputSchema: z.object({
    datasourceId: z.string(),
    datasourceName: z.string(),
  }),
  outputSchema: z.object({
    datasourceName: z.string(),
    metadataApiAvailable: z.boolean(),
    dimensions: z.array(z.object({ name: z.string(), dataType: z.string() })),
    measures: z.array(z.object({ name: z.string(), dataType: z.string() })),
    dates: z.array(z.object({ name: z.string(), dataType: z.string() })),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.get_datasource_metadata', { datasourceId: input.datasourceId }, async () => {
      const md = await TableauService.getMetadata(session, input.datasourceId, input.datasourceName);
      const map = (f: { name: string; dataType: string }) => ({ name: f.name, dataType: f.dataType });
      return {
        datasourceName: md.datasourceName,
        metadataApiAvailable: md.metadataApiAvailable,
        dimensions: md.dimensions.map(map),
        measures: md.measures.map(map),
        dates: md.dates.map(map),
      };
    });
  },
});

/** Lock the selected datasource as the single source of truth for the session. */
export const lockDatasourceTool = createTool({
  id: 'lock_datasource',
  description:
    'Lock a published datasource as the single source of truth for this session. After locking, all planning must use only this datasource.',
  inputSchema: z.object({ datasourceId: z.string(), datasourceName: z.string() }),
  outputSchema: z.object({ locked: z.boolean(), datasourceName: z.string(), lockedAt: z.string() }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    const all = await TableauService.listDatasources(session);
    const ds = all.find((d) => d.id === input.datasourceId);
    if (!ds) {
      throw new Error(`Datasource ${input.datasourceName} was not found among your accessible datasources.`);
    }
    const lock = TableauService.lockDatasource(session, ds);
    return { locked: true, datasourceName: lock.datasourceName, lockedAt: lock.lockedAt };
  },
});
