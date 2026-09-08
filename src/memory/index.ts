/**
 * Mastra Memory for the TableauPilot agent.
 *
 * Stores ONLY non-sensitive context that improves future dashboards:
 *  - visualization / chart preferences
 *  - dashboard style + naming conventions
 *  - prior requirements and formatting choices
 *
 * It NEVER stores credentials (PAT, Connected App secret, tokens, PIN). The
 * datasource lock is deliberately kept in ephemeral session/workflow state, not in
 * long-term memory. Working memory is seeded with a template that only contains
 * preference fields, reinforcing this boundary.
 */
import { Memory } from '@mastra/memory';
import { getStorage } from '../mastra/storage.js';

/** Working-memory template — preference fields only, no secrets. */
const WORKING_MEMORY_TEMPLATE = `# User Dashboard Preferences

- Preferred chart types:
- Color palette / theme:
- Dashboard naming convention:
- Default filters to include:
- Formatting notes (number formats, labels):
- Prior dashboard themes:
`;

let memory: Memory | undefined;

export function getAgentMemory(): Memory {
  if (memory) return memory;
  memory = new Memory({
    storage: getStorage(),
    options: {
      workingMemory: {
        enabled: true,
        template: WORKING_MEMORY_TEMPLATE,
      },
      lastMessages: 20,
    },
  });
  return memory;
}
