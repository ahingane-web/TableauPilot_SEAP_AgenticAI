/**
 * TableauService — the single façade the rest of the app (Mastra tools, workflows,
 * API routes) uses to talk to Tableau Cloud. It operates on a server-side Session:
 * it signs in with the vault's PAT, caches the live REST token in memory, and
 * exposes high-level operations. No Tableau HTTP happens outside this layer.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DashboardPlan } from '../schemas/dashboardPlan.js';
import type { DatasourceLock, FieldRole, TableauProjectContext } from '../schemas/common.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertApproved, assertDatasourceLock, assertProjectMatch } from '../validation/guards.js';
import { VaultService } from '../vault/vault.js';
import type { Session } from '../vault/session.js';
import { mintConnectedAppJwt, signIn } from './auth/index.js';
import {
  generateTwb,
  normalizeFieldKey,
  parseAlreadyDefinedCalcFields,
  removeCalculatedFields,
} from './authoring/twbGenerator.js';
import { buildViewUrl } from './authoring/index.js';
import { getDatasourceMetadata } from './datasources/index.js';
import {
  getProjects,
  getPublishedDatasources,
  getViews,
  getWorkbooks,
  getWorkbookViews,
} from './discovery/index.js';
import {
  checkDatasourceAccess,
  checkProjectPublishPermission,
  checkWorkbookEditPermission,
} from './permissions/index.js';
import { publishWorkbook } from './publishing/index.js';
import { publishDatasource } from './publishing/datasource.js';
import { randomBytes } from 'node:crypto';
import { generateSalesforceTds, salesforceToTwbDataType, salesforceToHyperType } from './authoring/tdsGenerator.js';
import { buildExtractTdsx, type ExtractColumn } from './publishing/hyperPackager.js';

/** Result of building/publishing a Salesforce extract datasource (API/UI contract). */
export interface ExtractResult {
  state: 'succeeded' | 'failed' | 'cancelled' | 'pending';
  message?: string;
}
import * as Salesforce from '../salesforce/client.js';
import type { SalesforceCredentials, SalesforceField, SalesforceSession, SalesforceTable } from '../salesforce/client.js';
import * as SalesforceOauth from '../salesforce/oauth.js';
import { putPendingOauth, takePendingOauth } from '../salesforce/oauthStore.js';
import { getConfig } from '../config/env.js';
import { getSession } from '../vault/session.js';
import { TableauClient } from './tableauClient.js';
import { verifyWorkbook } from './verification/index.js';
import type {
  DatasourceField,
  DatasourceMetadata,
  PermissionResult,
  PublishResult,
  TableauDatasource,
  TableauProject,
  TableauView,
  TableauWorkbook,
  WorkbookVerification,
} from './types.js';

const log = logger.child('tableau-service');

/** How long to trust a cached REST token before re-signing in. */
const TOKEN_MAX_AGE_MS = 55 * 60 * 1000;

function getClient(session: Session): TableauClient {
  const auth = session.tableauAuth;
  if (!auth) {
    throw new AppError('AUTH_REQUIRED', 'Not connected to Tableau Cloud. Connect first.');
  }
  return new TableauClient(auth.serverUrl, auth.token);
}

/** Extract the bare hostname (data-server host) from a Tableau Cloud server URL. */
function hostFromUrl(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function siteId(session: Session): string {
  return requireAuth(session).siteId;
}

function requireAuth(session: Session) {
  if (!session.tableauAuth) throw new AppError('AUTH_REQUIRED', 'Not connected to Tableau Cloud. Connect first.');
  return session.tableauAuth;
}

/**
 * Normalize a user-entered Salesforce host into a bare hostname for the connection
 * `server` attribute, e.g. `https://your-domain.my.salesforce.com/` -> `your-domain.my.salesforce.com`.
 */
function normalizeSalesforceHost(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

/** Map a Salesforce field (from `describe`) to a Tableau datasource field. */
function salesforceFieldToDatasourceField(f: SalesforceField): DatasourceField {
  const twb = salesforceToTwbDataType(f.type); // string|integer|real|boolean|date|datetime
  const dataType =
    twb === 'integer' ? 'INTEGER' : twb === 'real' ? 'REAL' : twb === 'boolean' ? 'BOOLEAN' : twb === 'date' ? 'DATE' : twb === 'datetime' ? 'DATETIME' : 'STRING';
  const isDate = twb === 'date' || twb === 'datetime';
  const role: FieldRole = twb === 'integer' || twb === 'real' ? 'measure' : 'dimension';
  return { name: f.name, role, dataType, isDate, fieldType: 'ColumnField' };
}

/** Build DatasourceMetadata from a Salesforce object's described fields. */
function salesforceFieldsToMetadata(
  datasourceId: string,
  datasourceName: string,
  fields: SalesforceField[],
): DatasourceMetadata {
  const seen = new Set<string>();
  const mapped: DatasourceField[] = [];
  for (const f of fields) {
    const name = f.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    mapped.push(salesforceFieldToDatasourceField(f));
  }
  return {
    datasourceId,
    datasourceName,
    fields: mapped,
    dimensions: mapped.filter((f) => f.role === 'dimension'),
    measures: mapped.filter((f) => f.role === 'measure'),
    dates: mapped.filter((f) => f.isDate),
    metadataApiAvailable: true,
  };
}

/** List Salesforce objects and store the transient connector state on the session. */
async function storeSalesforceConnectorState(
  session: Session,
  creds: SalesforceCredentials,
  sfSession: SalesforceSession,
): Promise<SalesforceTable[]> {
  const tables = await Salesforce.listObjects(sfSession);
  session.connectors = { ...(session.connectors ?? {}), salesforce: { creds, sfSession, tables } };
  return tables;
}

export const TableauService = {
  /** Sign in to Tableau Cloud using the vault's PAT credentials. */
  async connect(session: Session): Promise<{ siteId: string; siteContentUrl: string; userId: string; serverUrl: string }> {
    const fresh = session.tableauAuth && Date.now() - session.tableauAuth.signedInAt < TOKEN_MAX_AGE_MS;
    if (fresh && session.tableauAuth) {
      return { ...session.tableauAuth };
    }
    const creds = VaultService.getCredentials(session);
    const { auth, serverUrl } = await signIn(creds);
    session.tableauAuth = {
      token: auth.token,
      siteId: auth.siteId,
      siteContentUrl: auth.siteContentUrl,
      userId: auth.userId,
      serverUrl,
      signedInAt: Date.now(),
    };
    log.info('Connected to Tableau Cloud', { site: auth.siteContentUrl });
    return { siteId: auth.siteId, siteContentUrl: auth.siteContentUrl, userId: auth.userId, serverUrl };
  },

  isConnected(session: Session): boolean {
    return Boolean(session.tableauAuth);
  },

  async listProjects(session: Session): Promise<TableauProject[]> {
    return getProjects(getClient(session), siteId(session));
  },

  async listWorkbooks(session: Session): Promise<TableauWorkbook[]> {
    return getWorkbooks(getClient(session), siteId(session));
  },

  async listViews(session: Session): Promise<TableauView[]> {
    return getViews(getClient(session), siteId(session));
  },

  async listDatasources(session: Session): Promise<TableauDatasource[]> {
    return getPublishedDatasources(getClient(session), siteId(session));
  },

  async getMetadata(session: Session, datasourceId: string, datasourceName: string): Promise<DatasourceMetadata> {
    // Prefer fields captured at build time (e.g. Salesforce `describe`) so a freshly
    // built datasource is usable immediately, without waiting on Metadata API indexing.
    const cached = session.flow.connectorMetadata?.[datasourceId];
    if (cached && cached.fields.length > 0) return cached;
    return getDatasourceMetadata(getClient(session), datasourceId, datasourceName);
  },

  /** Set the approved publishing destination on the session. */
  setProjectContext(session: Session, project: TableauProjectContext): void {
    if (project.siteId !== siteId(session)) {
      throw new AppError('VALIDATION', 'Selected project is on a different site than the current session.');
    }
    session.flow.projectContext = project;
    log.info('Target project selected', { project: project.projectName });
  },

  /** Lock the datasource as the single source of truth for this session. */
  lockDatasource(session: Session, ds: TableauDatasource): DatasourceLock {
    const lock: DatasourceLock = {
      datasourceId: ds.id,
      datasourceName: ds.name,
      siteId: siteId(session),
      contentUrl: ds.contentUrl,
      lockedAt: new Date().toISOString(),
    };
    session.flow.datasourceLock = lock;
    log.info('Datasource locked', { datasource: ds.name });
    return lock;
  },

  unlockDatasource(session: Session): void {
    session.flow.datasourceLock = undefined;
    session.flow.plan = undefined;
    session.flow.approvedPlanHash = undefined;
    session.flow.workbook = undefined;
  },

  // ---------------------------------------------------------------------------
  // Build datasource (connector flow). These operate BEFORE the datasource lock:
  // they connect to a source (Salesforce), publish a new datasource to Tableau
  // Cloud, then converge on `lockDatasource` so the existing dashboard-building
  // flow runs unchanged on the freshly built datasource.
  // ---------------------------------------------------------------------------

  /** The connectors the Build-datasource flow supports. */
  listConnectors(): Array<{ id: string; label: string }> {
    return [{ id: 'salesforce', label: 'Salesforce' }];
  },

  /**
   * Connect to Salesforce with username/password and list its queryable objects.
   * The live Salesforce session + credentials are stored transiently on the
   * (memory-only) session so a subsequent publish can embed the connection
   * credentials. Nothing is logged.
   */
  async salesforceListTables(session: Session, creds: SalesforceCredentials): Promise<SalesforceTable[]> {
    requireAuth(session); // must be connected to Tableau first (publish target).
    const sfSession = await Salesforce.login(creds);
    return storeSalesforceConnectorState(session, creds, sfSession);
  },

  /**
   * Begin an interactive Salesforce OAuth (browser sign-in) authorization. Returns
   * the authorize URL the client should open in a popup, plus the callback URL that
   * must be registered on the Connected App. The PKCE verifier + client details are
   * stored transiently, keyed by an opaque `state`, so the header-less OAuth
   * callback can be routed back to this session.
   */
  salesforceOauthStart(
    session: Session,
    input: { url: string; clientId?: string; clientSecret?: string },
  ): { authUrl: string; redirectUri: string } {
    requireAuth(session);
    const cfg = getConfig().salesforce;
    // Prefer a server-configured Connected App (Tableau-connector-like UX where the
    // user only clicks "Sign in"). Fall back to client-supplied app credentials.
    const clientId = input.clientId || cfg.oauthClientId;
    const clientSecret = input.clientSecret || cfg.oauthClientSecret;
    if (!clientId) {
      throw new AppError(
        'CONNECTOR_API',
        'Salesforce browser sign-in is not configured. Set SALESFORCE_OAUTH_CLIENT_ID (and optionally SALESFORCE_OAUTH_CLIENT_SECRET) on the server, or use username/password.',
      );
    }
    const redirectUri = cfg.oauthRedirectUri;
    const state = SalesforceOauth.generateState();
    const pkce = SalesforceOauth.generatePkce();
    putPendingOauth(state, {
      sessionId: session.id,
      loginUrl: input.url,
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier: pkce.verifier,
    });
    const authUrl = SalesforceOauth.buildAuthorizeUrl({
      loginUrl: input.url,
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });
    return { authUrl, redirectUri };
  },

  /**
   * Complete an interactive Salesforce OAuth authorization from the callback. Looks
   * up the originating session by `state` (the callback has no session header),
   * exchanges the code for a token, lists objects, and stores the transient
   * connector state. Returns the resolved session id so the caller can proceed.
   */
  async completeSalesforceOauth(params: { code: string; state: string }): Promise<{ sessionId: string }> {
    const pending = takePendingOauth(params.state);
    if (!pending) {
      throw new AppError('AUTH_FAILED', 'This Salesforce sign-in link has expired or is invalid. Try again.');
    }
    const session = getSession(pending.sessionId);
    if (!session) {
      throw new AppError('AUTH_REQUIRED', 'Your session expired during Salesforce sign-in. Unlock your vault and retry.');
    }
    const token = await SalesforceOauth.exchangeCodeForToken({
      loginUrl: pending.loginUrl,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      redirectUri: pending.redirectUri,
      code: params.code,
      codeVerifier: pending.codeVerifier,
    });
    const { username } = await SalesforceOauth.fetchUserInfo(token);
    const sfSession = SalesforceOauth.sessionFromToken(token);
    // Password is not applicable for an OAuth-connected source; store the resolved
    // username + login origin so the datasource can be generated. Publishing should
    // use the OAuth credential mode (embed a saved Salesforce OAuth credential).
    const creds: SalesforceCredentials = { url: pending.loginUrl, username, password: '' };
    await storeSalesforceConnectorState(session, creds, sfSession);
    return { sessionId: session.id };
  },

  /** The tables listed for the current Salesforce connector session (non-secret). */
  salesforceListedTables(session: Session): SalesforceTable[] {
    return session.connectors?.salesforce?.tables ?? [];
  },

  /**
   * Build a Salesforce EXTRACT datasource for the chosen object and publish it to the
   * given Tableau Cloud project, then lock it as the session's source of truth for the
   * downstream dashboard flow.
   *
   * The Salesforce credentials are used transiently to `describe` the object and to
   * `query` its rows; those rows are materialized into a local `.hyper` (via the Python
   * Hyper sidecar) and packaged into a `.tdsx`. The datasource is published with NO
   * embedded credentials, so it is a static extract: viewable immediately, but not
   * refreshable on Tableau Cloud without re-publishing.
   */
  async buildAndPublishSalesforceDatasource(
    session: Session,
    input: {
      /** Salesforce credentials used ONLY to read + extract the object (describe/query). Not embedded. */
      credentials: SalesforceCredentials;
      /** Salesforce object (SObject) API name, e.g. `Account` or `My_Object__c`. */
      object: string;
      projectId: string;
      datasourceName: string;
      overwrite?: boolean;
      /** Emit `server-oauth='server-custom'` (default true — matches the reference). */
      serverOauthCustom?: boolean;
    },
  ): Promise<{
    datasource: TableauDatasource;
    lock: DatasourceLock;
    projectContext: TableauProjectContext;
    extract: ExtractResult;
  }> {
    requireAuth(session);

    const object = String(input.object ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object)) {
      throw new AppError(
        'VALIDATION',
        `Invalid Salesforce object name "${input.object}". Use the SObject API name, e.g. Account or My_Object__c.`,
      );
    }
    const username = String(input.credentials.username ?? '').trim();
    if (!username) {
      throw new AppError('VALIDATION', 'A Salesforce username is required.');
    }

    const project = (await this.listProjects(session)).find((p) => p.id === input.projectId);
    if (!project) {
      throw new AppError('NOT_FOUND', 'Target project not found among your accessible projects.');
    }

    // Sign in to Salesforce to read the object schema AND pull the rows for the extract.
    // The session/token is used transiently; NO Salesforce credential is embedded into
    // the published datasource (the extract is static — viewable, not refreshable).
    const sfSession = await Salesforce.login(input.credentials);
    const serverHost = normalizeSalesforceHost(sfSession.instanceUrl);
    const fields = await Salesforce.describeObject(sfSession, object);
    if (fields.length === 0) {
      throw new AppError('CONNECTOR_API', `Salesforce object "${object}" exposes no extractable fields.`);
    }
    const fieldNames = fields.map((f) => f.name);
    const maxRows = getConfig().hyper.maxRows;
    const rows = await Salesforce.queryRecords(sfSession, object, fieldNames, maxRows);

    // Build the `.tds` with an <extract> element backed by a locally materialized
    // `.hyper` (bundled in the `.tdsx` at this exact path).
    const hyperName = `federated_${randomBytes(10).toString('hex')}.hyper`;
    const tdsXml = generateSalesforceTds({
      datasourceName: input.datasourceName,
      serverHost,
      username,
      object,
      authMode: 'oauth',
      serverOauthCustom: input.serverOauthCustom,
      fields: fields.map((f) => ({ name: f.name, salesforceType: f.type, nillable: f.nillable })),
      extract: { hyperDbname: `Data/Extracts/${hyperName}` },
    });

    // Materialize the extract locally and package a `.tdsx` (Python Hyper sidecar).
    const schema: ExtractColumn[] = fields.map((f) => ({ name: f.name, type: salesforceToHyperType(f.type) }));
    const tdsxBuffer = await buildExtractTdsx({ tdsXml, object, hyperName, schema, rows });

    // Publish the packaged extract. NO connection credentials are embedded — the
    // datasource renders entirely from the bundled `.hyper`.
    const published = await publishDatasource(getClient(session), {
      siteId: siteId(session),
      projectId: project.id,
      datasourceName: input.datasourceName,
      tdsxBuffer,
      overwrite: input.overwrite,
    });

    // Publishing target for the eventual workbook = where we published the datasource.
    this.setProjectContext(session, { siteId: siteId(session), projectId: project.id, projectName: project.name });

    const ds: TableauDatasource = {
      id: published.id,
      name: published.name,
      contentUrl: published.contentUrl,
      projectId: published.projectId,
      projectName: published.projectName,
    };
    const lock = this.lockDatasource(session, ds);

    // Cache the described fields so the dashboard flow has real fields IMMEDIATELY,
    // without waiting on Tableau's async Metadata API indexing of the new datasource.
    session.flow.connectorMetadata = {
      ...(session.flow.connectorMetadata ?? {}),
      [ds.id]: salesforceFieldsToMetadata(ds.id, ds.name, fields),
    };

    // Discard any transient connector state now that publishing is complete.
    session.connectors = undefined;

    const rowsCapped = rows.length >= maxRows;
    const extract: ExtractResult = {
      state: 'succeeded',
      message: `Extract built with ${rows.length.toLocaleString()} row(s)${rowsCapped ? ` (capped at ${maxRows.toLocaleString()})` : ''}.`,
    };
    return { datasource: ds, lock, projectContext: session.flow.projectContext!, extract };
  },

  async checkProjectPublish(session: Session, project: TableauProjectContext): Promise<PermissionResult> {
    return checkProjectPublishPermission(getClient(session), siteId(session), project.projectId, requireAuth(session).userId, project.projectName);
  },

  async checkDatasourceAccess(session: Session, ds: TableauDatasource): Promise<PermissionResult> {
    return checkDatasourceAccess(getClient(session), siteId(session), ds.id, requireAuth(session).userId, ds.name);
  },

  async checkWorkbookEdit(session: Session, workbook: TableauWorkbook): Promise<PermissionResult> {
    return checkWorkbookEditPermission(getClient(session), siteId(session), workbook.id, requireAuth(session).userId, workbook.name);
  },

  /**
   * Publish an approved, validated plan. Enforces datasource lock, project match,
   * and approval BEFORE generating the .twb and uploading to the exact project.
   */
  async publishPlan(session: Session, plan: DashboardPlan, metadata: DatasourceMetadata): Promise<PublishResult> {
    assertDatasourceLock(session.flow.datasourceLock, plan);
    assertProjectMatch(session.flow.projectContext, plan);
    assertApproved(session.flow.approvedPlanHash, plan);

    const perm = await this.checkProjectPublish(session, {
      siteId: plan.publishing.siteId,
      projectId: plan.publishing.projectId,
      projectName: plan.publishing.projectName,
    });
    if (!perm.allowed) {
      throw new AppError('PERMISSION_DENIED', perm.reason, {
        hint: 'Select another project or request Publish permission.',
      });
    }

    const auth = requireAuth(session);

    // A workbook references a PUBLISHED datasource through Tableau's data server via a
    // `sqlproxy` connection whose `server` attribute is the pod's data-server host — i.e.
    // the hostname of the Tableau Cloud server URL. (Verified against a real workbook built
    // on a published datasource; there is NO repository-location.)
    const serverHost = hostFromUrl(auth.serverUrl);

    // Publish with a self-healing loop: if Tableau rejects the workbook because a
    // calculated field is "already defined by data source", it names the exact field.
    // We drop that calc (its worksheet references then bind to the datasource's own
    // field) and retry. This is authoritative — it uses Tableau's own view of the
    // datasource — and covers cases the Metadata API misses. The in-generator guard
    // (see renderColumns) already removes known collisions up front.
    let workingPlan = plan;
    const droppedCalcs: string[] = [];
    const MAX_PUBLISH_ATTEMPTS = 6;
    for (let attempt = 1; ; attempt++) {
      const twb = generateTwb(workingPlan, metadata, { serverHost });
      // DIAGNOSTIC (opt-in): dump the exact generated workbook to a temp file so the
      // precise XML that gets published can be inspected (no secrets — just the .twb
      // layout). Off by default; enable with TABLEAUPILOT_DEBUG_DUMP=1.
      if (process.env.TABLEAUPILOT_DEBUG_DUMP === '1') {
        try {
          const dumpPath = join(tmpdir(), 'tableaupilot-last.twb');
          writeFileSync(dumpPath, twb);
          log.info('DIAGNOSTIC: wrote generated workbook', {
            path: dumpPath,
            bytes: twb.length,
            dashboards: (twb.match(/<dashboard name='/g) ?? []).length,
            worksheets: workingPlan.worksheets.length,
            planDashboards: workingPlan.dashboards.length,
            filterZones: (twb.match(/type-v2='filter'/g) ?? []).length,
            emptyZones: (twb.match(/type-v2='empty'/g) ?? []).length,
            legendZones: (twb.match(/type-v2='(color|size|shape)'/g) ?? []).length,
          });
        } catch {
          /* best-effort diagnostic only */
        }
      }
      // Log the datasource binding block (field names + datasource name only — no
      // secrets) so a failed publish load can be diagnosed precisely.
      const dsBlock = twb.match(/<datasources>[\s\S]*?<\/datasources>/)?.[0];
      log.info('Publishing workbook — datasource binding', {
        siteContentUrl: auth.siteContentUrl,
        serverHost,
        attempt,
        datasourceName: plan.datasource.datasourceName,
        datasourceContentUrl: plan.datasource.contentUrl,
        droppedCalculatedFields: droppedCalcs,
        datasourceBlock: dsBlock,
      });
      try {
        const result = await publishWorkbook(getClient(session), {
          siteId: plan.publishing.siteId,
          projectId: plan.publishing.projectId,
          workbookName: plan.publishing.workbookName,
          twbXml: twb,
          overwrite: plan.publishing.overwrite,
          showTabs: plan.publishing.showTabs,
        });
        session.flow.workbook = {
          workbookId: result.workbookId,
          name: result.name,
          webpageUrl: result.webpageUrl,
          contentUrl: result.contentUrl,
        };
        return result;
      } catch (err) {
        const reported = err instanceof AppError ? parseAlreadyDefinedCalcFields(err.message) : [];
        const novel = reported.filter(
          (name) => !droppedCalcs.some((d) => normalizeFieldKey(d) === normalizeFieldKey(name)),
        );
        if (novel.length > 0 && attempt < MAX_PUBLISH_ATTEMPTS) {
          droppedCalcs.push(...novel);
          workingPlan = removeCalculatedFields(workingPlan, novel);
          log.warn('Datasource already defines calculated field(s); reusing them and retrying publish', {
            fields: novel,
            attempt,
          });
          continue;
        }
        throw err;
      }
    }
  },

  /** Verify a published workbook actually exists in the expected project + resolve URL. */
  async verify(session: Session, workbookId: string, expected: { projectId?: string; dashboardName?: string }): Promise<WorkbookVerification> {
    return verifyWorkbook(getClient(session), siteId(session), workbookId, expected);
  },

  /** Views (sheets/dashboards) of a published workbook — used to build the view-only URL. */
  async getWorkbookViews(session: Session, workbookId: string): Promise<TableauView[]> {
    return getWorkbookViews(getClient(session), siteId(session), workbookId);
  },

  /**
   * Build READ-ONLY embed info for the published dashboard: the `<tableau-viz>` src
   * (with `:embed=yes&:toolbar=no` so only the dashboard shows) plus a short-lived
   * Connected App JWT (if configured) for seamless auth. Returns
   * `requiresInteractiveLogin` when no Connected App is configured (the embed then
   * shows Tableau's own login). Web Authoring (editing) is intentionally NOT offered.
   */
  getEmbedInfo(session: Session, opts: { view?: TableauView; workbook?: TableauWorkbook }): {
    src?: string;
    token?: string;
    tokenExpiresAt?: number;
    requiresInteractiveLogin: boolean;
    embeddingLibraryUrl: string;
  } {
    const auth = requireAuth(session);
    const creds = VaultService.getCredentials(session);
    const embeddingLibraryUrl = `${auth.serverUrl.replace(/\/+$/, '')}/javascripts/api/tableau.embedding.3.latest.min.js`;

    const src = buildViewUrl({
      serverUrl: auth.serverUrl,
      siteContentUrl: auth.siteContentUrl,
      view: opts.view,
      workbook: opts.workbook,
    });

    if (creds.connectedApp?.secretValue) {
      // Read-only viewing only needs the view-embed scope.
      const { token, expiresAt } = mintConnectedAppJwt(creds, {
        username: auth.userId || creds.patName,
        scopes: ['tableau:views:embed'],
      });
      return { src, token, tokenExpiresAt: expiresAt, requiresInteractiveLogin: false, embeddingLibraryUrl };
    }
    return { src, requiresInteractiveLogin: true, embeddingLibraryUrl };
  },
};

export type { DatasourceMetadata, PermissionResult, PublishResult, WorkbookVerification } from './types.js';
