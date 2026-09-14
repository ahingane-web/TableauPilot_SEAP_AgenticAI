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
import { z } from 'zod';
import { getConfig } from '../config/env.js';
import {
  generateDashboardPlan,
  reviseDashboardPlan,
  approvePlan,
  setPublishingOptions,
  setDashboardSize,
  setDashboardAppearance,
  setDashboardActions,
  updateWorksheetFormatting,
} from '../planning/index.js';
import { hashPlan } from '../validation/guards.js';
import {
  HexColorSchema,
  TextFormatSchema,
  SalesforceCredentialsSchema,
  SalesforceBuildSchema,
  ExcelBuildSchema,
  FitModeSchema,
} from '../schemas/common.js';
import { ReferenceLineSpecSchema, ColorMapSpecSchema, GrandTotalsSchema } from '../schemas/worksheetSpec.js';
import { runPublishAndVerify } from '../execution/index.js';
import { TableauService } from '../tableau/index.js';
import type { TableauView } from '../tableau/types.js';
import { AppError, sanitizeError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { VaultService } from '../vault/vault.js';
import type { Session } from '../vault/session.js';
import type { TableauCredentials } from '../vault/types.js';

const log = logger.child('api');

// ---- Plan-edit request schemas (no LLM re-run) -----------------------------
const AppearanceReqSchema = z.object({
  backgroundColor: z.union([HexColorSchema, z.literal('')]).optional(),
  containerBackground: z.union([HexColorSchema, z.literal('')]).optional(),
  titleFormat: TextFormatSchema.nullable().optional(),
});
const ActionsReqSchema = z.object({
  enabled: z.boolean(),
  runOn: z.enum(['select', 'hover', 'menu']).optional(),
  caption: z.string().optional(),
  excludeSheets: z.array(z.string()).optional(),
});
const WorksheetFormatReqSchema = z.object({
  name: z.string().min(1),
  referenceLines: z.array(ReferenceLineSpecSchema).optional(),
  grandTotals: GrandTotalsSchema.nullable().optional(),
  colorMap: ColorMapSpecSchema.nullable().optional(),
  showLabels: z.boolean().optional(),
  titleFormat: TextFormatSchema.nullable().optional(),
  /** Field to place on the color mark (empty string clears it). */
  colorField: z.union([z.string(), z.literal('')]).nullable().optional(),
  /** Per-sheet fit inside its dashboard zone (null clears back to the chart-type default). */
  fit: FitModeSchema.nullable().optional(),
});

/** First few zod issues as readable strings for a VALIDATION error's details. */
function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).slice(0, 8);
}

/**
 * Minimal HTML returned to the OAuth popup: it notifies the opener window (so the
 * app can proceed to table selection) and closes itself. No secrets are included.
 */
function oauthResultHtml(result: { ok: boolean; message?: string }): string {
  const payload = JSON.stringify({ type: 'sf-oauth', ok: result.ok, message: result.message ?? '' });
  const heading = result.ok ? 'Salesforce connected' : 'Salesforce sign-in failed';
  const detail = result.ok
    ? 'You can close this window and return to TableauPilot.'
    : escapeHtml(result.message ?? 'Please try again.');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px;color:#1a1a1a">
<h3>${heading}</h3><p>${detail}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${payload}, '*'); } catch (e) {}
  setTimeout(function(){ window.close(); }, 800);
</script>
</body></html>`;
}

/** Escape text for safe inclusion in the OAuth result HTML body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requireSession(c: { req: { header: (k: string) => string | undefined } }): Session {
  const id = c.req.header('x-session-id');
  return VaultService.requireSession(id);
}

/** Build a TableauCredentials object from a request body (shared by save + update). */
function readCredentials(body: Partial<TableauCredentials>): TableauCredentials {
  return {
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
    if (safe.status >= 500) {
      // safe.details is already redacted; include it to aid diagnosis (e.g. the
      // requestUrl / contentType / bodyPreview attached to Tableau API errors).
      log.error('Unhandled API error', { code: safe.code, message: safe.message, details: safe.details });
    }
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
    const creds = readCredentials(await c.req.json<Partial<TableauCredentials>>());
    const summary = VaultService.saveCredentials(session, creds);
    return c.json({ saved: true, credentialSummary: summary });
  });

  // Non-secret summary of saved credentials — used to prefill the edit form.
  app.get('/api/vault/credentials', (c) => {
    const session = requireSession(c);
    return c.json({ credentialSummary: VaultService.getCredentialSummary(session) });
  });

  // Modify saved credentials — requires the PIN again, even within a session.
  app.post('/api/vault/credentials/update', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json<{ pin?: string } & Partial<TableauCredentials>>();
    const pin = String(body.pin ?? '');
    if (!pin) throw new AppError('VALIDATION', 'Your 6-digit PIN is required to modify credentials.');
    const creds = readCredentials(body);
    const summary = VaultService.updateCredentials(session, pin, creds);
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
      unavailableReason: md.unavailableReason,
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

  // ------------------------------------------------------------- Connectors (Build datasource)
  // Alternative to locking an existing published datasource: connect to a source
  // (Salesforce), build a datasource, and publish it. On success the flow converges
  // on the same datasource lock + project context the published path produces, so the
  // downstream dashboard-building flow is unchanged.
  app.get('/api/connectors', (c) => {
    requireSession(c);
    const sf = getConfig().salesforce;
    // `oauthConfigured` tells the UI whether the server holds a Connected App, so it
    // can render a single "Sign in with Salesforce" button (like Tableau's connector)
    // instead of asking the user for a Consumer Key/Secret.
    const oauthConfigured = Boolean(sf.oauthClientId);
    const items = TableauService.listConnectors().map((it) =>
      it.id === 'salesforce'
        ? { ...it, oauthRedirectUri: sf.oauthRedirectUri, oauthConfigured }
        : it,
    );
    return c.json({ items });
  });

  app.post('/api/connectors/salesforce/connect', async (c) => {
    const session = requireSession(c);
    const parsed = SalesforceCredentialsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new AppError('VALIDATION', 'Salesforce url, username, and password are required.', {
        details: { issues: zodIssues(parsed.error) },
      });
    }
    const tables = await TableauService.salesforceListTables(session, parsed.data);
    // Return only non-secret table identity to the client.
    return c.json({ tables: tables.map((t) => ({ name: t.name, label: t.label })) });
  });

  // Interactive OAuth (browser sign-in). The agent opens `authUrl` in a popup; the
  // user authenticates with Salesforce; Salesforce redirects to the callback below.
  app.post('/api/connectors/salesforce/oauth/start', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json<{ url?: string; clientId?: string; clientSecret?: string }>();
    const url = String(body.url ?? '').trim();
    const clientId = String(body.clientId ?? '').trim();
    if (!url) throw new AppError('VALIDATION', 'A Salesforce login URL is required.');
    // clientId is optional here: the server may provide a pre-registered Connected
    // App (SALESFORCE_OAUTH_CLIENT_ID). salesforceOauthStart enforces that at least
    // one source of a client id exists and throws a clear error otherwise.
    const { authUrl, redirectUri } = TableauService.salesforceOauthStart(session, {
      url,
      clientId: clientId || undefined,
      clientSecret: body.clientSecret?.trim() || undefined,
    });
    return c.json({ authUrl, redirectUri });
  });

  // OAuth redirect target (no session header — routed back via `state`). Renders a
  // tiny page that notifies the opener window and closes the popup.
  app.get('/api/connectors/salesforce/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const oauthError = c.req.query('error_description') ?? c.req.query('error');
    try {
      if (oauthError) throw new AppError('AUTH_FAILED', `Salesforce sign-in was cancelled or failed: ${oauthError}`);
      if (!code || !state) throw new AppError('VALIDATION', 'Missing OAuth code/state from Salesforce.');
      await TableauService.completeSalesforceOauth({ code, state });
      return c.html(oauthResultHtml({ ok: true }));
    } catch (err) {
      const safe = sanitizeError(err);
      return c.html(oauthResultHtml({ ok: false, message: safe.message }), safe.status as 400);
    }
  });

  // The tables listed for the current Salesforce connector session (used by the UI
  // after the OAuth popup completes).
  app.get('/api/connectors/salesforce/tables', (c) => {
    const session = requireSession(c);
    const tables = TableauService.salesforceListedTables(session).map((t) => ({ name: t.name, label: t.label }));
    return c.json({ tables });
  });

  // Describe a Salesforce object's fields (name/label/type) for the relationship
  // builder's join-field dropdowns. Uses the transient connector session.
  app.post('/api/connectors/salesforce/describe', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json<{ object?: string }>();
    const object = String(body.object ?? '').trim();
    if (!object) throw new AppError('VALIDATION', 'Provide a Salesforce object/table to describe (e.g. Account).');
    const fields = await TableauService.salesforceDescribeObject(session, object);
    return c.json({ fields });
  });

  app.post('/api/connectors/salesforce/publish', async (c) => {
    const session = requireSession(c);
    const raw = await c.req.json<{
      credentials?: unknown;
      object?: string;
      tables?: unknown;
      relationships?: unknown;
      mode?: unknown;
      projectId?: string;
      datasourceName?: string;
      overwrite?: boolean;
      serverOauthCustom?: boolean;
    }>();
    // Back-compat: a legacy `{ object }` body maps to a single-table build.
    const tables = Array.isArray(raw.tables)
      ? raw.tables
      : raw.object
        ? [raw.object]
        : [];
    // Salesforce credentials are used ONLY to read the object schema (describe); they are
    // never embedded in the published datasource (publishing uses the saved credential).
    const parsed = SalesforceBuildSchema.safeParse({
      credentials: raw.credentials,
      tables,
      relationships: Array.isArray(raw.relationships) ? raw.relationships : [],
      ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
      projectId: raw.projectId,
      datasourceName: raw.datasourceName,
      overwrite: raw.overwrite,
      serverOauthCustom: raw.serverOauthCustom,
    });
    if (!parsed.success) {
      throw new AppError('VALIDATION', 'Invalid Salesforce datasource request. Check the objects, relationships, project, and name.', {
        details: { issues: zodIssues(parsed.error) },
      });
    }
    const result = await TableauService.buildAndPublishSalesforceDatasource(session, {
      credentials: parsed.data.credentials,
      tables: parsed.data.tables,
      relationships: parsed.data.relationships,
      mode: parsed.data.mode,
      projectId: parsed.data.projectId,
      datasourceName: parsed.data.datasourceName,
      overwrite: Boolean(parsed.data.overwrite),
      // Default true (matches the reference); allow the client to opt into built-in OAuth.
      serverOauthCustom: parsed.data.serverOauthCustom !== false,
    });
    return c.json({
      datasource: { id: result.datasource.id, name: result.datasource.name, projectName: result.datasource.projectName },
      extract: { state: result.extract.state, message: result.extract.message },
      ...contextSnapshot(session),
    });
  });

  // Upload an Excel workbook (.xlsx/.xlsm) via multipart. The server parses it once and
  // returns the sheet list + per-sheet column identity (used as the "objects"/fields for
  // the same relationship builder Salesforce uses). Parsed rows are held transiently in the
  // session until the Excel datasource is published.
  app.post('/api/connectors/excel/upload', async (c) => {
    const session = requireSession(c);
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) {
      throw new AppError('VALIDATION', 'Attach an .xlsx file to upload (form field "file").');
    }
    const name = file.name || 'workbook.xlsx';
    if (!/\.(xlsx|xlsm)$/i.test(name)) {
      throw new AppError('VALIDATION', 'Unsupported file type. Upload a modern Excel workbook (.xlsx or .xlsm).');
    }
    const maxBytes = 25 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new AppError('VALIDATION', 'That file is too large. The maximum upload size is 25 MB.');
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await TableauService.excelStoreUpload(session, buffer, name);
    return c.json(result);
  });

  // Build an Excel EXTRACT datasource from the uploaded workbook (single sheet, or multiple
  // sheets joined via relationships/physical join) and publish it EXTRACT-ONLY.
  app.post('/api/connectors/excel/publish', async (c) => {
    const session = requireSession(c);
    const raw = await c.req.json<{
      sheets?: unknown;
      relationships?: unknown;
      mode?: unknown;
      projectId?: string;
      datasourceName?: string;
      overwrite?: boolean;
    }>();
    const parsed = ExcelBuildSchema.safeParse({
      sheets: Array.isArray(raw.sheets) ? raw.sheets : [],
      relationships: Array.isArray(raw.relationships) ? raw.relationships : [],
      ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
      projectId: raw.projectId,
      datasourceName: raw.datasourceName,
      overwrite: raw.overwrite,
    });
    if (!parsed.success) {
      throw new AppError('VALIDATION', 'Invalid Excel datasource request. Check the sheets, relationships, project, and name.', {
        details: { issues: zodIssues(parsed.error) },
      });
    }
    const result = await TableauService.excelBuildAndPublishDatasource(session, {
      sheets: parsed.data.sheets,
      relationships: parsed.data.relationships,
      mode: parsed.data.mode,
      projectId: parsed.data.projectId,
      datasourceName: parsed.data.datasourceName,
      overwrite: Boolean(parsed.data.overwrite),
    });
    return c.json({
      datasource: { id: result.datasource.id, name: result.datasource.name, projectName: result.datasource.projectName },
      extract: { state: result.extract.state, message: result.extract.message },
      ...contextSnapshot(session),
    });
  });

  // ------------------------------------------------------------- Dashboard
  app.post('/api/dashboard/plan', async (c) => {
    const session = requireSession(c);
    const { request, workbookName } = await c.req.json<{ request?: string; workbookName?: string }>();
    if (!request || !request.trim()) throw new AppError('VALIDATION', 'Describe the dashboard you want.');
    const result = await generateDashboardPlan(session, request.trim(), workbookName?.trim() || undefined);
    return c.json(result);
  });

  // Update workbook name / overwrite on the current plan (no LLM re-run). Invalidates
  // approval so the user re-approves with the final publishing target.
  app.post('/api/dashboard/publishing', async (c) => {
    const session = requireSession(c);
    const { workbookName, overwrite } = await c.req.json<{ workbookName?: string; overwrite?: boolean }>();
    const result = await setPublishingOptions(session, { workbookName, overwrite });
    return c.json(result);
  });

  // Set the dashboard size (Automatic / Fixed / Range) chosen by the user before publish.
  // No LLM re-run; invalidates approval so the user re-approves with the final size.
  app.post('/api/dashboard/size', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json<{
      size?: 'automatic' | 'fixed' | 'range';
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      maxWidth?: number;
      maxHeight?: number;
    }>();
    if (!body.size || !['automatic', 'fixed', 'range'].includes(body.size)) {
      throw new AppError('VALIDATION', 'size must be one of automatic, fixed, range.');
    }
    const result = await setDashboardSize(session, { ...body, size: body.size });
    return c.json(result);
  });

  // Dashboard appearance (background/container colors + title font). No LLM re-run.
  app.post('/api/dashboard/appearance', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json();
    const parsed = AppearanceReqSchema.safeParse(body);
    if (!parsed.success) throw new AppError('VALIDATION', 'Invalid appearance settings.', { details: { issues: zodIssues(parsed.error) } });
    const result = await setDashboardAppearance(session, parsed.data);
    return c.json(result);
  });

  // Dashboard interactivity (use-as-filter action). No LLM re-run.
  app.post('/api/dashboard/actions', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json();
    const parsed = ActionsReqSchema.safeParse(body);
    if (!parsed.success) throw new AppError('VALIDATION', 'Invalid interactivity settings.', { details: { issues: zodIssues(parsed.error) } });
    const result = await setDashboardActions(session, parsed.data);
    return c.json(result);
  });

  // Per-worksheet formatting (reference lines, grand totals, colors, labels, title). No LLM re-run.
  app.post('/api/dashboard/worksheet-format', async (c) => {
    const session = requireSession(c);
    const body = await c.req.json();
    const parsed = WorksheetFormatReqSchema.safeParse(body);
    if (!parsed.success) throw new AppError('VALIDATION', 'Invalid worksheet formatting.', { details: { issues: zodIssues(parsed.error) } });
    const result = await updateWorksheetFormatting(session, parsed.data);
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
    return c.json(await approvePlan(session, planHash));
  });

  app.post('/api/dashboard/execute', async (c) => {
    const session = requireSession(c);
    const result = await runPublishAndVerify(session);
    return c.json(result);
  });

  // Chat: revise the CURRENT (unpublished) plan with a natural-language instruction.
  // Re-runs the planner on the existing plan; invalidates approval so the user re-approves.
  app.post('/api/dashboard/revise', async (c) => {
    const session = requireSession(c);
    const { instruction } = await c.req.json<{ instruction?: string }>();
    if (!instruction?.trim()) throw new AppError('VALIDATION', 'An instruction is required to revise the plan.');
    return c.json(await reviseDashboardPlan(session, instruction.trim()));
  });

  // Chat: modify an ALREADY-PUBLISHED workbook. Revises the plan, targets the same
  // workbook (overwrite in place), auto-approves the user's explicit request, then
  // republishes + verifies. Returns the fresh CreationResult so the viewer can reload.
  app.post('/api/published/revise', async (c) => {
    const session = requireSession(c);
    const { instruction } = await c.req.json<{ instruction?: string }>();
    if (!instruction?.trim()) throw new AppError('VALIDATION', 'An instruction is required to modify the dashboard.');
    const wb = session.flow.workbook;
    if (!wb) throw new AppError('VALIDATION', 'No published workbook to modify — publish one first.');

    await reviseDashboardPlan(session, instruction.trim());
    const plan = session.flow.plan!;
    // Overwrite the SAME published workbook in place.
    plan.publishing.workbookName = wb.name;
    plan.publishing.overwrite = true;
    session.flow.plan = plan;
    // The chat instruction IS the user's explicit approval of this change.
    await approvePlan(session, hashPlan(plan));
    const result = await runPublishAndVerify(session);
    return c.json(result);
  });

  // ------------------------------------------------------------- Embed (read-only view)
  app.get('/api/embed/info', async (c) => {
    const session = requireSession(c);
    const wb = session.flow.workbook;
    // Resolve a real VIEW (its contentUrl is "Workbook/sheets/Sheet") so the view-only URL
    // is exact: `/#/site/<site>/views/<Workbook>/<Sheet>`. The workbook's own webpageUrl is a
    // `/workbooks/...` URL and cannot produce a view path on its own.
    let view: TableauView | undefined;
    if (wb) {
      try {
        const views = await TableauService.getWorkbookViews(session, wb.workbookId);
        // Prefer a dashboard sheet named like the plan's first board; else the first view.
        const planName = session.flow.plan?.dashboards?.[0]?.name ?? session.flow.plan?.dashboardName;
        const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase();
        view =
          (planName ? views.find((v) => norm(v.name) === norm(planName)) : undefined) ??
          views[0];
      } catch {
        /* fall back to workbook-only resolution below */
      }
    }
    const info = TableauService.getEmbedInfo(session, {
      view,
      workbook: wb
        ? { id: wb.workbookId, name: wb.name, webpageUrl: wb.webpageUrl, contentUrl: wb.contentUrl }
        : undefined,
    });
    // The Connected App token is short-lived and INTENDED for the browser embed.
    return c.json(info);
  });

  return app;
}
