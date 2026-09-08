/**
 * The Mastra instance.
 *
 * Registers the agent, all workflows, shared storage, and a logger. `mastra dev`
 * discovers this export and serves Mastra Studio (agent/workflow/tool testing,
 * tracing, structured-output inspection, memory). The app's own API server imports
 * the same agent/workflows/services, so Studio and production share one brain.
 */
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { tableauPilotAgent } from '../agents/tableauPilotAgent.js';
import { workflows } from '../workflows/index.js';
import { getConfig } from '../config/env.js';
import { getStorage } from './storage.js';

export const mastra = new Mastra({
  agents: { tableauPilotAgent },
  workflows,
  storage: getStorage(),
  logger: new PinoLogger({
    name: 'TableauPilot',
    level: mapLevel(getConfig().app.logLevel),
  }),
});

function mapLevel(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'): 'debug' | 'info' | 'warn' | 'error' {
  return level.toLowerCase() as 'debug' | 'info' | 'warn' | 'error';
}
