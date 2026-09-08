/**
 * Server bootstrap.
 *
 * Starts the backend API (Hono) on API_PORT, validates boot configuration, and
 * starts the session sweeper. In production it also serves the built web assets.
 * Mastra Studio runs separately via `npm run dev:studio` (`mastra dev`).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { assertBootConfig, describeConfig, getConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { describeModel } from '../llm/index.js';
import { startSessionSweeper } from '../vault/session.js';
import { createApp } from './app.js';

const log = logger.child('server');

function main(): void {
  const cfg = getConfig();
  try {
    assertBootConfig();
  } catch (err) {
    log.error('Boot configuration invalid', { message: (err as Error).message });
    // Surface the actionable message directly (no secrets in it).
    process.stderr.write(`\n${(err as Error).message}\n\n`);
    process.exit(1);
  }

  const app = createApp();

  // Serve built SPA in production (dist/web) if present.
  const webDir = resolve(process.cwd(), 'dist/web');
  if (cfg.app.isProduction && existsSync(webDir)) {
    app.use('/*', serveStatic({ root: './dist/web' }));
    app.get('*', serveStatic({ path: './dist/web/index.html' }));
    log.info('Serving built web assets', { webDir });
  }

  startSessionSweeper();

  serve({ fetch: app.fetch, port: cfg.app.apiPort }, (info) => {
    log.info('TableauPilot API listening', { port: info.port, config: describeConfig(), model: describeModel() });
  });
}

main();
