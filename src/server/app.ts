/**
 * Backend API (Hono).
 *
 * This is the app's BFF. The browser talks ONLY to these routes; it never sees a
 * Tableau token, PAT, Connected App secret, or gateway key. Secrets live in the
 * per-user encrypted vault and in memory-only sessions. The client holds an opaque
 * session id (x-session-id header). Every error is sanitized before it leaves.
 *
 * The same service layer powers Mastra Studio (via `mastra dev`), so the agent,
 * workflows, and tools you debug in Studio are exactly what runs here.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getConfig } from '../config/env.js';
import { generateDashboardPlan, approvePlan } from '../planning/index.js';
import { runPublishAndVerify } from '../execution/index.js';
import { TableauService } from '../tableau/index.js';
import { AppError, sanitizeError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { VaultService } from '../vault/vault.js';
import type { Session } from '../vault/session.js';
import type { TableauCredentials } from '../vault/types.js';

const log = logger.child('api');

function requireSession(c: { req: { header: (k: string) => string | undefined } }): Session {
  const id = c.req.header('x-session-id');
  return VaultService.requireSession(id);
}

/** Non-secret snapshot of session flow context for the client. */
function contextSnapshot(session: Session) {
  return {
    username: session.username,
    connected: TableauService.isConnected(session),
    hasCredentials: Boolean(session.credentials),
    projectContext: session.flow.projectContext ?? null,
    datasourceLock: session.flow.datasourceLock ?? null,
    hasPlan: Boolean(session.flow.plan),
    approved: Boolean(session.flow.approvedPlanHash),
    workbook: session.flow.workbook ?? null,
  };
}

export function createApp(): Hono {
  const app = new Hono();
  const cfg = getConfig();

  app.use('*', cors({ origin: cfg.app.corsOrigins, allowHeaders: ['Content-Type', 'x-session-id'] }));

  // Central error boundary — sanitize everything.
  app.onError((err, c) => {
    const safe = sanitizeError(err);
    if (safe.status >= 500) log.error('Unhandled API error', { code: safe.code, message: safe.message });
    return c.json({ error: safe }, safe.status as 400);
  });

  app.get('/api/health', (c) => c.json({ ok: true, service: 'tableaupilot', version: '0.1.0' }));

  // ----------------------------------------------------------------- Vault
  app.post('/api/vault/register', async (c) => {
    const { username, pin } = await c.req.json<{ username?: string; pin?: string }>();
    const res = VaultService.register(String(username ?? ''), String(pin ?? ''));
    return c.json(res);
  });

  app.post('/api/vault/unlock', async (c) => {
    const { username, pin } = await c.req.json<{ username?: string; pin?: string }>();
    const res = VaultService.unlock(String(username ?? ''), String(pin ?? ''));
    return c.json(res);
  });

  app.post('/api/vault/logout', (c) => {
    const id = c.req.header('x-session-id');
    if (id) VaultService.logout(id);
    return c.json({ ok: true });
  });

  app.get('/api/vault/session', (c) => {
    const session = requireSession(c);
    return c.json(contextSnapshot(session));
  });

  app.post('/api/vault/credentials', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json<Partial<TableauCredentials>>();
    const creds: TableauCredentials = {
      cloudUrl: String(body.cloudUrl ?? '').trim(),
      siteContentUrl: String(body.siteContentUrl ?? '').trim(),
      patName: String(body.patName ?? '').trim(),
      patSecret: String(body.patSecret ?? ''),
      connectedApp: body.connectedApp?.clientId
        ? {
            clientId: String(body.connectedApp.clientId),
            secretId: String(body.connectedApp.secretId ?? ''),
            secretValue: String(body.connectedApp.secretValue ?? ''),
          }
        : undefined,
    };
    const summary = VaultService.saveCredentials(session, creds);
    return c.json({ saved: true, credentialSummary: summary });
  });

  // ------------------------------------------------------------- Tableau
  app.post('/api/tableau/connect', async (c) => {
    const session = requireSession(c);
    const res = await TableauService.connect(session);
    return c.json({ connected: true, siteContentUrl: res.siteContentUrl, userId: res.userId });
  });

  app.get('/api/tableau/projects', async (c) => c.json({ items: await TableauService.listProjects(requireSession(c)) }));
  app.get('/api/tableau/datasources', async (c) => c.json({ items: await TableauService.listDatasources(requireSession(c)) }));
  app.get('/api/tableau/workbooks', async (c) => c.json({ items: await TableauService.listWorkbooks(requireSession(c)) }));
  app.get('/api/tableau/views', async (c) => c.json({ items: await TableauService.listViews(requireSession(c)) }));

  app.get('/api/tableau/datasource/:id/metadata', async (c) => {
    const session = requireSession(c);
    const id = c.req.param('id');
    const name = c.req.query('name') ?? '';
    const md = await TableauService.getMetadata(session, id, name);
    return c.json({
      datasourceName: md.datasourceName,
      metadataApiAvailable: md.metadataApiAvailable,
      dimensions: md.dimensions,
      measures: md.measures,
      dates: md.dates,
      fieldCount: md.fields.length,
    });
  });

  app.post('/api/tableau/select-project', async (c) => {
    const session = requireSession(c);
    const { projectId } = await c.req.json<{ projectId?: string }>();
    const project = (await TableauService.listProjects(session)).find((p) => p.id === projectId);
    if (!project) throw new AppError('NOT_FOUND', 'Project not found among your accessible projects.');
    const auth = session.tableauAuth;
    if (!auth) throw new AppError('AUTH_REQUIRED', 'Connect to Tableau Cloud first.');
    TableauService.setProjectContext(session, { siteId: auth.siteId, projectId: project.id, projectName: project.name });
    return c.json({ projectContext: session.flow.projectContext });
  });

  app.post('/api/tableau/lock-datasource', async (c) => {
    const session = requireSession(c);
    const { datasourceId } = await c.req.json<{ datasourceId?: string }>();
    const ds = (await TableauService.listDatasources(session)).find((d) => d.id === datasourceId);
    if (!ds) throw new AppError('NOT_FOUND', 'Datasource not found among your accessible datasources.');
    const lock = TableauService.lockDatasource(session, ds);
    return c.json({ datasourceLock: lock });
  });

  app.post('/api/tableau/unlock-datasource', (c) => {
    const session = requireSession(c);
    TableauService.unlockDatasource(session);
    return c.json({ datasourceLock: null });
  });

  app.get('/api/tableau/context', (c) => c.json(contextSnapshot(requireSession(c))));

  // ------------------------------------------------------------- Dashboard
  app.post('/api/dashboard/plan', async (c) => {
    const session = requireSession(c);
    const { request } = await c.req.json<{ request?: string }>();
    if (!request || !request.trim()) throw new AppError('VALIDATION', 'Describe the dashboard you want.');
    const result = await generateDashboardPlan(session, request.trim());
    return c.json(result);
  });

  app.get('/api/dashboard/plan', (c) => {
    const session = requireSession(c);
    return c.json({ plan: session.flow.plan ?? null, approved: Boolean(session.flow.approvedPlanHash) });
  });

  app.post('/api/dashboard/approve', async (c) => {
    const session = requireSession(c);
    const { planHash } = await c.req.json<{ planHash?: string }>();
    if (!planHash) throw new AppError('VALIDATION', 'planHash is required to approve.');
    return c.json(approvePlan(session, planHash));
  });

  app.post('/api/dashboard/execute', async (c) => {
    const session = requireSession(c);
    const result = await runPublishAndVerify(session);
    return c.json(result);
  });

  // ------------------------------------------------------------- Embed
  app.get('/api/embed/info', (c) => {
    const session = requireSession(c);
    const mode = (c.req.query('mode') as 'new_workbook' | 'existing_workbook') ?? 'existing_workbook';
    const wb = session.flow.workbook;
    const lock = session.flow.datasourceLock;
    const info = TableauService.getEmbedInfo(session, {
      mode,
      datasource: lock ? { id: lock.datasourceId, name: lock.datasourceName, contentUrl: lock.contentUrl } : undefined,
      workbook: wb
        ? { id: wb.workbookId, name: wb.name, webpageUrl: wb.webpageUrl, contentUrl: wb.contentUrl }
        : undefined,
    });
    // The Connected App token is short-lived and INTENDED for the browser embed.
    return c.json(info);
  });

  return app;
}
