import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { withSpan } from '../observability/index.js';
import { requireSessionFromContext } from './context.js';

/**
 * Connect to Tableau Cloud (REST sign-in) using the vault's PAT. Returns only
 * non-secret session facts (site, user id) — never the auth token.
 */
export const authenticateTableauTool = createTool({
  id: 'authenticate_tableau',
  description:
    'Connect to the user\'s Tableau Cloud site using their saved credentials. Returns the site content URL and user id. Must be called before discovery.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    connected: z.boolean(),
    siteContentUrl: z.string(),
    userId: z.string(),
  }),
  execute: async (_input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.authenticate_tableau', {}, async () => {
      const res = await TableauService.connect(session);
      return { connected: true, siteContentUrl: res.siteContentUrl, userId: res.userId };
    });
  },
});
