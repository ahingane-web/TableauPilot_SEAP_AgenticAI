/**
 * TableauService — the single façade the rest of the app (Mastra tools, workflows,
 * API routes) uses to talk to Tableau Cloud. It operates on a server-side Session:
 * it signs in with the vault's PAT, caches the live REST token in memory, and
 * exposes high-level operations. No Tableau HTTP happens outside this layer.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DashboardPlan } from '../schemas/dashboardPlan.js';
import type {
  DatasourceLock,
  FieldRole,
  TableauProjectContext,
  SalesforceRelationship,
  SalesforceBuildMode,
} from '../schemas/common.js';
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
import {
  publishDatasource,
  refreshDatasourceNow,
  listDatasourceConnections,
  embedDatasourceConnectionCredential,
} from './publishing/datasource.js';
import { randomBytes } from 'node:crypto';
import {
  generateSalesforceTds,
  generateSalesforceRelationshipsTds,
  generateSalesforcePhysicalJoinTds,
  salesforceToTwbDataType,
  salesforceToHyperType,
} from './authoring/tdsGenerator.js';
import {
  generateExcelTds,
  generateExcelRelationshipsTds,
  generateExcelPhysicalJoinTds,
  excelToHyperType,
} from './authoring/excelTdsGenerator.js';
import {
  generateBigQueryTds,
  generateBigQueryRelationshipsTds,
  generateBigQueryPhysicalJoinTds,
  bigQueryObjectId,
  bigQueryToHyperType,
  bigQueryFieldIdentities,
  type BigQueryMaterialization,
  type BigQueryTableSpec,
  type BigQueryRelationshipSpec,
  type BigQueryConnectionInfo,
  type BigQueryFieldIdentity,
} from './authoring/bigqueryTdsGenerator.js';
import {
  generateDataCloudTds,
  generateDataCloudRelationshipsTds,
  generateDataCloudPhysicalJoinTds,
  dataCloudObjectId,
  dataCloudToHyperType,
  dataCloudFieldIdentities,
  type DataCloudMaterialization,
  type DataCloudTableSpec,
  type DataCloudRelationshipSpec,
  type DataCloudConnectionInfo,
  type DataCloudFieldIdentity,
} from './authoring/dataCloudTdsGenerator.js';
import {
  generateSnowflakeTds,
  generateSnowflakeRelationshipsTds,
  generateSnowflakePhysicalJoinTds,
  snowflakeObjectId,
  snowflakeToHyperType,
  snowflakeFieldIdentities,
  type SnowflakeMaterialization,
  type SnowflakeTableSpec,
  type SnowflakeRelationshipSpec,
  type SnowflakeConnectionInfo,
  type SnowflakeFieldIdentity,
} from './authoring/snowflakeTdsGenerator.js';
import { buildExtractTdsx, type ExtractColumn, type ExtractTable } from './publishing/hyperPackager.js';
import { parseWorkbook, type ExcelSheet, type ExcelColumn } from '../excel/excelClient.js';
import * as BigQuery from '../bigquery/client.js';
import type { BigQueryField } from '../bigquery/client.js';
import * as DataCloud from '../datacloud/client.js';
import type { DataCloudAuth, DataCloudField, DataCloudObjectCategory } from '../datacloud/client.js';
import * as Snowflake from '../snowflake/client.js';
import type { SnowflakeAuth, SnowflakeCredentials, SnowflakeField } from '../snowflake/client.js';
import * as BigQueryOauth from '../bigquery/oauth.js';
import { putPendingBigQueryOauth, takePendingBigQueryOauth } from '../bigquery/oauthStore.js';

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

/**
 * Build DatasourceMetadata for a MULTI-object (relationships) datasource. Field names
 * are qualified as `Object.Field` so they stay collision-free across joined objects and
 * match the `[Object.Field]` aliases emitted in the generated `.tds`.
 */
function salesforceTablesToMetadata(
  datasourceId: string,
  datasourceName: string,
  tables: Array<{ object: string; fields: SalesforceField[] }>,
): DatasourceMetadata {
  const seen = new Set<string>();
  const mapped: DatasourceField[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      const name = f.name?.trim();
      if (!name) continue;
      const qualified = `${t.object}.${name}`;
      if (seen.has(qualified)) continue;
      seen.add(qualified);
      mapped.push({ ...salesforceFieldToDatasourceField(f), name: qualified });
    }
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

/** Map a parsed Excel column to a Tableau datasource field. */
function excelColumnToDatasourceField(c: ExcelColumn, name = c.name): DatasourceField {
  const dataType =
    c.type === 'integer'
      ? 'INTEGER'
      : c.type === 'real'
        ? 'REAL'
        : c.type === 'boolean'
          ? 'BOOLEAN'
          : c.type === 'date'
            ? 'DATE'
            : c.type === 'datetime'
              ? 'DATETIME'
              : 'STRING';
  const isDate = c.type === 'date' || c.type === 'datetime';
  const role: FieldRole = c.type === 'integer' || c.type === 'real' ? 'measure' : 'dimension';
  return { name, role, dataType, isDate, fieldType: 'ColumnField' };
}

/** Build DatasourceMetadata from a single Excel sheet's columns. */
function excelFieldsToMetadata(datasourceId: string, datasourceName: string, sheet: ExcelSheet): DatasourceMetadata {
  const mapped: DatasourceField[] = sheet.columns.map((c) => excelColumnToDatasourceField(c));
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

/**
 * Build DatasourceMetadata for a MULTI-sheet Excel datasource. Field names are qualified
 * `SheetId.Field` so they stay collision-free and match the `[SheetId.Field]` aliases
 * emitted in the generated `.tds` (mirrors {@link salesforceTablesToMetadata}).
 */
function excelSheetsToMetadata(datasourceId: string, datasourceName: string, sheets: ExcelSheet[]): DatasourceMetadata {
  const mapped: DatasourceField[] = [];
  for (const s of sheets) {
    for (const c of s.columns) {
      mapped.push(excelColumnToDatasourceField(c, `${s.id}.${c.name}`));
    }
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

/** Map a BigQuery field identity (from the generator's normalization) to a Tableau datasource field. */
function bigQueryIdentityToDatasourceField(id: BigQueryFieldIdentity): DatasourceField {
  const twb = id.twb; // string|integer|real|boolean|date|datetime
  const dataType =
    twb === 'integer'
      ? 'INTEGER'
      : twb === 'real'
        ? 'REAL'
        : twb === 'boolean'
          ? 'BOOLEAN'
          : twb === 'date'
            ? 'DATE'
            : twb === 'datetime'
              ? 'DATETIME'
              : 'STRING';
  const isDate = twb === 'date' || twb === 'datetime';
  const role: FieldRole = twb === 'integer' || twb === 'real' ? 'measure' : 'dimension';
  // The field's identity in the published datasource is its disambiguated local-name.
  return { name: id.local, role, dataType, isDate, fieldType: 'ColumnField' };
}

/**
 * Build DatasourceMetadata for a BigQuery datasource from the generator's field identities,
 * so the dashboard flow has real fields IMMEDIATELY (without waiting on Metadata API
 * indexing) and its references match the published datasource's column identities exactly.
 */
function bigQueryTablesToMetadata(
  datasourceId: string,
  datasourceName: string,
  tables: BigQueryTableSpec[],
): DatasourceMetadata {
  const identities = bigQueryFieldIdentities(tables);
  const seen = new Set<string>();
  const mapped: DatasourceField[] = [];
  for (const id of identities) {
    if (seen.has(id.local)) continue;
    seen.add(id.local);
    mapped.push(bigQueryIdentityToDatasourceField(id));
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

/**
 * Return a valid BigQuery access token for the session, refreshing it first if it is (near)
 * expired and a refresh token is available. Updates the transient session state in place.
 * The token is memory-only and never logged.
 */
async function bigQueryAuth(session: Session): Promise<BigQuery.BigQueryAuth> {
  const bq = session.connectors?.bigquery;
  if (!bq?.accessToken) {
    throw new AppError('CONNECTOR_API', 'Not signed in to Google BigQuery. Sign in first.');
  }
  const nearExpiry = bq.expiresAt != null && Date.now() > bq.expiresAt - 60_000;
  if (nearExpiry && bq.refreshToken) {
    try {
      const refreshed = await BigQueryOauth.refreshAccessToken({
        clientId: bq.clientId,
        clientSecret: bq.clientSecret,
        refreshToken: bq.refreshToken,
      });
      bq.accessToken = refreshed.accessToken;
      bq.expiresAt = refreshed.expiresAt;
      if (refreshed.refreshToken) bq.refreshToken = refreshed.refreshToken;
    } catch (err) {
      log.warn('BigQuery token refresh failed; using existing token', {
        error: err instanceof AppError ? err.message : String(err),
      });
    }
  }
  return { accessToken: bq.accessToken };
}

function dataCloudIdentityToDatasourceField(id: DataCloudFieldIdentity): DatasourceField {
  const twb = id.twb;
  const dataType =
    twb === 'integer'
      ? 'INTEGER'
      : twb === 'real'
        ? 'REAL'
        : twb === 'boolean'
          ? 'BOOLEAN'
          : twb === 'date'
            ? 'DATE'
            : twb === 'datetime'
              ? 'DATETIME'
              : 'STRING';
  const isDate = twb === 'date' || twb === 'datetime';
  const role: FieldRole = twb === 'integer' || twb === 'real' ? 'measure' : 'dimension';
  return { name: id.local, role, dataType, isDate, fieldType: 'ColumnField' };
}

function dataCloudTablesToMetadata(
  datasourceId: string,
  datasourceName: string,
  tables: DataCloudTableSpec[],
): DatasourceMetadata {
  const identities = dataCloudFieldIdentities(tables);
  const seen = new Set<string>();
  const mapped: DatasourceField[] = [];
  for (const id of identities) {
    if (seen.has(id.local)) continue;
    seen.add(id.local);
    mapped.push(dataCloudIdentityToDatasourceField(id));
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

function dataCloudAuth(session: Session): DataCloudAuth {
  const dc = session.connectors?.datacloud;
  if (!dc?.cdp?.accessToken) {
    throw new AppError('CONNECTOR_API', 'Not signed in to Salesforce Data Cloud. Connect first.');
  }
  return dc.cdp;
}

/**
 * Salesforce scopes the CDP token by data space. Re-exchange when the caller asks for
 * a space the current token was not issued for.
 */
async function dataCloudAuthForSpace(session: Session, dataSpace: string): Promise<DataCloudAuth> {
  const dc = session.connectors?.datacloud;
  if (!dc?.cdp?.accessToken || !dc.sfSession) {
    throw new AppError('CONNECTOR_API', 'Not signed in to Salesforce Data Cloud. Connect first.');
  }
  const wanted = String(dataSpace ?? '').trim();
  const current = (dc.cdp.dataSpace || 'default').trim();
  if (wanted && current !== wanted) {
    dc.cdp = await DataCloud.exchangeCdpToken(dc.sfSession, wanted);
  }
  return dc.cdp;
}

function snowflakeIdentityToDatasourceField(id: SnowflakeFieldIdentity): DatasourceField {
  const twb = id.twb;
  const dataType =
    twb === 'integer'
      ? 'INTEGER'
      : twb === 'real'
        ? 'REAL'
        : twb === 'boolean'
          ? 'BOOLEAN'
          : twb === 'date'
            ? 'DATE'
            : twb === 'datetime'
              ? 'DATETIME'
              : 'STRING';
  const isDate = twb === 'date' || twb === 'datetime';
  const role: FieldRole = twb === 'integer' || twb === 'real' ? 'measure' : 'dimension';
  return { name: id.local, role, dataType, isDate, fieldType: 'ColumnField' };
}

function snowflakeTablesToMetadata(
  datasourceId: string,
  datasourceName: string,
  database: string,
  schema: string,
  tables: SnowflakeTableSpec[],
): DatasourceMetadata {
  const identities = snowflakeFieldIdentities(database, schema, tables);
  const seen = new Set<string>();
  const mapped: DatasourceField[] = [];
  for (const id of identities) {
    if (seen.has(id.local)) continue;
    seen.add(id.local);
    mapped.push(snowflakeIdentityToDatasourceField(id));
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

function snowflakeAuth(session: Session): SnowflakeAuth {
  const sf = session.connectors?.snowflake;
  if (!sf?.auth?.token) {
    throw new AppError('CONNECTOR_API', 'Not signed in to Snowflake. Connect first.');
  }
  return sf.auth;
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
    return [
      { id: 'salesforce', label: 'Salesforce' },
      { id: 'excel', label: 'Excel (.xlsx)' },
      { id: 'bigquery', label: 'Google BigQuery' },
      { id: 'datacloud', label: 'Salesforce Data Cloud' },
      { id: 'snowflake', label: 'Snowflake' },
    ];
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
    const sfSession = await SalesforceOauth.sessionFromToken(token);
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
   * Describe a Salesforce object's queryable fields using the transient connector
   * session established by connect / OAuth. Powers the relationship-builder field
   * dropdowns. Returns non-secret field identity (name/label/type) only.
   */
  async salesforceDescribeObject(
    session: Session,
    object: string,
  ): Promise<Array<{ name: string; label: string; type: string }>> {
    requireAuth(session);
    const sf = session.connectors?.salesforce;
    if (!sf?.sfSession) {
      throw new AppError('CONNECTOR_API', 'Not connected to Salesforce. Connect first, then add tables.');
    }
    const name = String(object ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw new AppError('VALIDATION', `Invalid Salesforce object name "${object}".`);
    }
    const fields = await Salesforce.describeObject(sf.sfSession, name);
    return fields.map((f) => ({ name: f.name, label: f.label, type: f.type }));
  },

  /**
   * Parse an uploaded Excel workbook and stash it as transient connector state, returning
   * non-secret sheet identity (id/caption/rowCount + column name/label/type) for the UI's
   * sheet + relationship builder. The parsed rows are held in memory only until the Excel
   * datasource is published (or the session is cleared). Mirrors the role Salesforce's
   * `connect` + `describe` play, but sourced entirely from the uploaded file (no network).
   */
  async excelStoreUpload(
    session: Session,
    buffer: Buffer,
    filename: string,
  ): Promise<{
    uploadId: string;
    filename: string;
    sheets: Array<{
      id: string;
      caption: string;
      rowCount: number;
      fields: Array<{ name: string; label: string; type: string }>;
    }>;
  }> {
    requireAuth(session);
    const cfg = getConfig();
    const parsed = await parseWorkbook(buffer, { maxRows: cfg.hyper.maxRows });
    if (parsed.sheets.length === 0) {
      throw new AppError('CONNECTOR_API', 'No readable sheets were found in the uploaded workbook.');
    }
    const uploadId = randomBytes(8).toString('hex');
    const safeName = basename(String(filename ?? '').trim()) || 'workbook.xlsx';
    session.connectors = {
      ...(session.connectors ?? {}),
      excel: { uploadId, filename: safeName, sheets: parsed.sheets },
    };
    return {
      uploadId,
      filename: safeName,
      sheets: parsed.sheets.map((s) => ({
        id: s.id,
        caption: s.caption,
        rowCount: s.rows.length,
        fields: s.columns.map((c) => ({ name: c.name, label: c.label, type: c.type })),
      })),
    };
  },

  /**
   * Build an Excel EXTRACT datasource from the uploaded workbook (single sheet, or multiple
   * sheets joined via relationships/physical join) and publish it to the given Tableau Cloud
   * project, then lock it as the session's source of truth.
   *
   * The datasource is EXTRACT-ONLY: the selected sheets' rows are materialized into a local
   * `.hyper` (via the Python Hyper sidecar) and packaged into a `.tdsx`. It is published with
   * NO connection credentials and NO server-side refresh — the bundled extract IS the data,
   * and the `excel-direct` connection is retained only for schema/lineage. Salesforce build
   * logic is untouched.
   */
  async excelBuildAndPublishDatasource(
    session: Session,
    input: {
      /** Identifier-safe sheet ids (from {@link excelStoreUpload}). One = single-table; many = relationships. */
      sheets: string[];
      /** Data-modeling edges connecting the sheets (empty for a single-sheet build). */
      relationships?: SalesforceRelationship[];
      /** Multi-sheet data-modeling mode: relationships (object-graph) or a physical join. */
      mode?: SalesforceBuildMode;
      /** Target Tableau project id to publish into. */
      projectId: string;
      /** Name for the new datasource. */
      datasourceName: string;
      /** Overwrite an existing datasource of the same name. */
      overwrite?: boolean;
    },
  ): Promise<{
    datasource: TableauDatasource;
    lock: DatasourceLock;
    projectContext: TableauProjectContext;
    extract: ExtractResult;
  }> {
    requireAuth(session);

    const excel = session.connectors?.excel;
    if (!excel?.sheets?.length) {
      throw new AppError('CONNECTOR_API', 'No Excel workbook is loaded. Upload a .xlsx file first.');
    }
    const wantedIds = (input.sheets ?? []).map((s) => String(s ?? '').trim());
    if (wantedIds.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one sheet to build a datasource.');
    }
    if (new Set(wantedIds).size !== wantedIds.length) {
      throw new AppError('VALIDATION', 'Duplicate sheets are not allowed.');
    }
    const byId = new Map(excel.sheets.map((s) => [s.id, s]));
    const selected: ExcelSheet[] = wantedIds.map((id) => {
      const s = byId.get(id);
      if (!s) throw new AppError('VALIDATION', `Sheet "${id}" was not found in the uploaded workbook.`);
      return s;
    });

    const relationships = input.relationships ?? [];
    const project = (await this.listProjects(session)).find((p) => p.id === input.projectId);
    if (!project) {
      throw new AppError('NOT_FOUND', 'Target project not found among your accessible projects.');
    }

    // Validate every relationship's join fields exist on the respective selected sheets.
    const colSetBySheet = new Map(selected.map((s) => [s.id, new Set(s.columns.map((c) => c.name))]));
    for (const r of relationships) {
      if (!colSetBySheet.get(r.leftObject)?.has(r.leftField)) {
        throw new AppError('VALIDATION', `Join field "${r.leftField}" was not found on sheet "${r.leftObject}".`);
      }
      if (!colSetBySheet.get(r.rightObject)?.has(r.rightField)) {
        throw new AppError('VALIDATION', `Join field "${r.rightField}" was not found on sheet "${r.rightObject}".`);
      }
    }

    const hyperName = `federated_${randomBytes(10).toString('hex')}.hyper`;
    const hyperDbname = `Data/Extracts/${hyperName}`;
    const isMulti = selected.length > 1;
    const primary = selected[0]!;
    const mode = input.mode ?? 'relationship';

    let tdsXml: string;
    if (isMulti) {
      const tables = selected.map((s) => ({
        sheet: s.id,
        caption: s.caption,
        columns: s.columns.map((c) => ({ name: c.name, type: c.type })),
      }));
      const relInput = {
        datasourceName: input.datasourceName,
        filename: excel.filename,
        tables,
        relationships,
        extract: { hyperDbname },
      };
      tdsXml = mode === 'join' ? generateExcelPhysicalJoinTds(relInput) : generateExcelRelationshipsTds(relInput);
    } else {
      tdsXml = generateExcelTds({
        datasourceName: input.datasourceName,
        filename: excel.filename,
        sheet: primary.id,
        caption: primary.caption,
        columns: primary.columns.map((c) => ({ name: c.name, type: c.type })),
        extract: { hyperDbname },
      });
    }

    // Materialize the extract locally and package a `.tdsx` (Python Hyper sidecar).
    const extractTables: ExtractTable[] = selected.map((s) => ({
      object: s.id,
      schema: s.columns.map((c) => ({ name: c.name, type: excelToHyperType(c.type) })) as ExtractColumn[],
      rows: s.rows,
    }));
    const tdsxBuffer = await buildExtractTdsx({ tdsXml, hyperName, tables: extractTables });

    // Publish EXTRACT-ONLY: no connection credentials embedded, and no server-side refresh
    // (there is no live credential to re-pull from). "Include external files" is satisfied by
    // the bundled `.hyper` — the datasource is viewable immediately from the extract.
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

    // Cache the sheet fields so the dashboard flow has real fields immediately. Multi-sheet
    // fields are qualified (`SheetId.Field`) to match the generated `.tds` aliases.
    session.flow.connectorMetadata = {
      ...(session.flow.connectorMetadata ?? {}),
      [ds.id]: isMulti
        ? excelSheetsToMetadata(ds.id, ds.name, selected)
        : excelFieldsToMetadata(ds.id, ds.name, primary),
    };

    // Discard the transient upload now that publishing is complete.
    session.connectors = undefined;

    const totalRows = selected.reduce((sum, s) => sum + s.rows.length, 0);
    const anyCapped = selected.some((s) => s.rows.length >= getConfig().hyper.maxRows);
    const tableSummary = isMulti ? ` across ${selected.length} sheets` : '';
    const extract: ExtractResult = {
      state: 'succeeded',
      message:
        `Extract built with ${totalRows.toLocaleString()} row(s)${tableSummary}` +
        `${anyCapped ? ` (some sheets capped at ${getConfig().hyper.maxRows.toLocaleString()})` : ''}. ` +
        `Published as an extract-only datasource.`,
    };
    return { datasource: ds, lock, projectContext: session.flow.projectContext!, extract };
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
      /** Salesforce credentials used ONLY to read + extract the objects (describe/query). Not embedded. */
      credentials: SalesforceCredentials;
      /** Salesforce object(s) (SObject API names) to include. One = single-table; many = relationships. */
      tables: string[];
      /** Data-modeling edges connecting the objects (empty for a single-table build). */
      relationships?: Array<{
        leftObject: string;
        leftField: string;
        rightObject: string;
        rightField: string;
        cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
        joinType?: 'inner' | 'left' | 'right' | 'full';
      }>;
      /** Multi-object data-modeling mode: relationships (object-graph) or a physical join. */
      mode?: 'relationship' | 'join';
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

    const tables = (input.tables ?? []).map((t) => String(t ?? '').trim());
    if (tables.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one Salesforce object to build a datasource.');
    }
    for (const object of tables) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object)) {
        throw new AppError(
          'VALIDATION',
          `Invalid Salesforce object name "${object}". Use the SObject API name, e.g. Account or My_Object__c.`,
        );
      }
    }
    if (new Set(tables).size !== tables.length) {
      throw new AppError('VALIDATION', 'Duplicate Salesforce objects are not allowed.');
    }
    const relationships = input.relationships ?? [];
    const username = String(input.credentials.username ?? '').trim();
    if (!username) {
      throw new AppError('VALIDATION', 'A Salesforce username is required.');
    }

    const project = (await this.listProjects(session)).find((p) => p.id === input.projectId);
    if (!project) {
      throw new AppError('NOT_FOUND', 'Target project not found among your accessible projects.');
    }

    // Sign in to Salesforce to read each object's schema AND pull its rows for the extract.
    // The session/token is used transiently; NO Salesforce credential is embedded into the
    // published datasource (the extract is static — viewable, not refreshable).
    const sfSession = await Salesforce.login(input.credentials);
    const serverHost = normalizeSalesforceHost(sfSession.instanceUrl);
    const maxRows = getConfig().hyper.maxRows;

    // Describe + query every object (one Hyper table per object).
    const described: Array<{ object: string; fields: SalesforceField[]; rows: Array<Array<unknown>> }> = [];
    for (const object of tables) {
      const fields = await Salesforce.describeObject(sfSession, object);
      if (fields.length === 0) {
        throw new AppError('CONNECTOR_API', `Salesforce object "${object}" exposes no extractable fields.`);
      }
      const rows = await Salesforce.queryRecords(sfSession, object, fields.map((f) => f.name), maxRows);
      described.push({ object, fields, rows });
    }

    // Validate every relationship's join fields exist on the respective described objects.
    const fieldSetByObject = new Map(described.map((d) => [d.object, new Set(d.fields.map((f) => f.name))]));
    for (const r of relationships) {
      if (!fieldSetByObject.get(r.leftObject)?.has(r.leftField)) {
        throw new AppError('VALIDATION', `Join field "${r.leftField}" was not found on object "${r.leftObject}".`);
      }
      if (!fieldSetByObject.get(r.rightObject)?.has(r.rightField)) {
        throw new AppError('VALIDATION', `Join field "${r.rightField}" was not found on object "${r.rightObject}".`);
      }
    }

    // Build the `.tds` (single-object or relationships) with an <extract> element backed by
    // a locally materialized `.hyper` (bundled in the `.tdsx` at this exact path).
    const hyperName = `federated_${randomBytes(10).toString('hex')}.hyper`;
    const hyperDbname = `Data/Extracts/${hyperName}`;
    const isMulti = described.length > 1;
    const primary = described[0]!; // guaranteed: `tables` has >= 1 entry
    const mode = input.mode ?? 'relationship';

    let tdsXml: string;
    if (isMulti) {
      // Shared multi-object input: same objects, fields, and edges for both models — only
      // the `.tds` shape differs (object-graph relationships vs a physical `<relation type='join'>`).
      const multiInput = {
        datasourceName: input.datasourceName,
        serverHost,
        username,
        authMode: 'oauth' as const,
        serverOauthCustom: input.serverOauthCustom,
        tables: described.map((d) => ({
          object: d.object,
          fields: d.fields.map((f) => ({ name: f.name, salesforceType: f.type, nillable: f.nillable })),
        })),
        relationships: relationships.map((r) => ({
          leftObject: r.leftObject,
          leftField: r.leftField,
          rightObject: r.rightObject,
          rightField: r.rightField,
          cardinality: r.cardinality,
          joinType: r.joinType,
        })),
        extract: { hyperDbname },
      };
      tdsXml =
        mode === 'join'
          ? generateSalesforcePhysicalJoinTds(multiInput)
          : generateSalesforceRelationshipsTds(multiInput);
    } else {
      tdsXml = generateSalesforceTds({
        datasourceName: input.datasourceName,
        serverHost,
        username,
        object: primary.object,
        authMode: 'oauth',
        serverOauthCustom: input.serverOauthCustom,
        fields: primary.fields.map((f) => ({ name: f.name, salesforceType: f.type, nillable: f.nillable })),
        extract: { hyperDbname },
      });
    }

    // Materialize the extract locally and package a `.tdsx` (Python Hyper sidecar).
    const extractTables = described.map((d) => ({
      object: d.object,
      schema: d.fields.map((f) => ({ name: f.name, type: salesforceToHyperType(f.type) })) as ExtractColumn[],
      rows: d.rows,
    }));
    const tdsxBuffer = await buildExtractTdsx({ tdsXml, hyperName, tables: extractTables });

    // Publish the packaged extract AND embed the publishing user's SAVED Salesforce OAuth
    // credential (matched by the connection `username`) so the datasource can connect and
    // refresh unattended. The bundled `.hyper` gives immediate data; the embedded credential
    // makes the extract refreshable (see the runNow refresh below + scheduled refreshes).
    const published = await publishDatasource(getClient(session), {
      siteId: siteId(session),
      projectId: project.id,
      datasourceName: input.datasourceName,
      tdsxBuffer,
      overwrite: input.overwrite,
      connectionCredentials: { name: username, oAuth: true, embed: true },
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

    // Cache the described fields so the dashboard flow has real fields IMMEDIATELY, without
    // waiting on Tableau's async Metadata API indexing. Multi-object fields are qualified
    // (`Object.Field`) to stay collision-free and match the generated `.tds` aliases.
    session.flow.connectorMetadata = {
      ...(session.flow.connectorMetadata ?? {}),
      [ds.id]: isMulti
        ? salesforceTablesToMetadata(ds.id, ds.name, described.map((d) => ({ object: d.object, fields: d.fields })))
        : salesforceFieldsToMetadata(ds.id, ds.name, primary.fields),
    };

    // Discard any transient connector state now that publishing is complete.
    session.connectors = undefined;

    // Embed the saved Salesforce OAuth credential on the published connection(s) (matched by
    // username) so the datasource is CONNECTABLE and the user can refresh it on demand or on a
    // schedule. Best-effort: a failure (e.g. no saved credential yet) must NOT fail the publish
    // — the datasource is already usable from the bundled `.hyper`.
    try {
      const conns = await listDatasourceConnections(getClient(session), siteId(session), ds.id);
      for (const conn of conns) {
        await embedDatasourceConnectionCredential(getClient(session), siteId(session), ds.id, conn.id, {
          userName: username,
        });
      }
    } catch (err) {
      log.warn('Could not embed saved credential on datasource connection after publish', {
        datasourceId: ds.id,
        error: err instanceof AppError ? err.message : String(err),
      });
    }

    // Final step: kick off a server-side extract refresh ("Update Data Source Now") on the
    // published datasource so Tableau re-pulls the data live using the embedded credential and
    // records a refresh in the datasource's history. Best-effort — a failure (e.g. no saved
    // credential yet) must NOT fail the publish, since the bundled `.hyper` already contains
    // data queried fresh at publish time.
    // NOTE: for a multi-object datasource (relationships/joins) Tableau rebuilds the extract
    // with its own engine on refresh; if the refreshed datasource shows only the first table,
    // it's this server-side rebuild — the bundled extract at publish time contains all tables.
    let refreshNote = '';
    try {
      const { jobId } = await refreshDatasourceNow(getClient(session), siteId(session), ds.id);
      refreshNote = jobId
        ? ` Started a server-side extract refresh (job ${jobId}).`
        : ' Started a server-side extract refresh.';
    } catch (err) {
      log.warn('Could not start extract refresh after publish', {
        datasourceId: ds.id,
        error: err instanceof AppError ? err.message : String(err),
      });
      refreshNote =
        ' Note: could not start the extract refresh automatically — verify your saved Salesforce credential on Tableau Cloud, then use "Refresh Extracts" on the datasource.';
    }

    const totalRows = described.reduce((sum, d) => sum + d.rows.length, 0);
    const anyCapped = described.some((d) => d.rows.length >= maxRows);
    const tableSummary = isMulti ? ` across ${described.length} tables` : '';
    const extract: ExtractResult = {
      state: 'succeeded',
      message:
        `Extract built with ${totalRows.toLocaleString()} row(s)${tableSummary}` +
        `${anyCapped ? ` (some tables capped at ${maxRows.toLocaleString()})` : ''}.${refreshNote}`,
    };
    return { datasource: ds, lock, projectContext: session.flow.projectContext!, extract };
  },

  // ---------------------------------------------------------------------------
  // BigQuery connector (Build datasource). Interactive Google OAuth (browser
  // sign-in), then list billing-project > project > dataset > tables, describe,
  // and build + publish a LIVE or EXTRACT datasource. On success the flow
  // converges on the SAME datasource lock + project context the other connectors
  // produce. Salesforce and Excel connector logic is untouched.
  // ---------------------------------------------------------------------------

  /**
   * Begin an interactive Google OAuth (browser sign-in) authorization for BigQuery. Returns
   * the authorize URL the client opens in a popup, plus the callback URL that must be
   * registered on the Google OAuth client. The PKCE verifier + client details are stored
   * transiently, keyed by an opaque `state`, so the header-less callback can be routed back.
   */
  bigQueryOauthStart(
    session: Session,
    input: { clientId?: string; clientSecret?: string } = {},
  ): { authUrl: string; redirectUri: string } {
    requireAuth(session);
    const cfg = getConfig().bigquery;
    // Resolve the OAuth client id/secret in priority order: this request (UI-entered) →
    // the user's vault-saved client → server env. This lets each user bring their own
    // Google OAuth client (saved encrypted in their vault) without any `.env` config.
    const saved = VaultService.getBigQueryOAuthClient(session);
    const clientId = input.clientId || saved.clientId || cfg.oauthClientId;
    const clientSecret = input.clientSecret || saved.clientSecret || cfg.oauthClientSecret;
    if (!clientId) {
      throw new AppError(
        'CONNECTOR_API',
        'Google BigQuery browser sign-in is not configured. Enter your Google OAuth Client ID in the connector (optionally save it to your vault), or set GOOGLE_OAUTH_CLIENT_ID on the server.',
      );
    }
    const redirectUri = cfg.oauthRedirectUri;
    const state = BigQueryOauth.generateState();
    const pkce = BigQueryOauth.generatePkce();
    putPendingBigQueryOauth(state, {
      sessionId: session.id,
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier: pkce.verifier,
    });
    const authUrl = BigQueryOauth.buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge: pkce.challenge });
    return { authUrl, redirectUri };
  },

  /**
   * Complete an interactive Google OAuth authorization from the callback. Looks up the
   * originating session by `state`, exchanges the code for an access/refresh token, reads
   * the account email (the connection username), and stores the transient BigQuery state.
   */
  async completeBigQueryOauth(params: { code: string; state: string }): Promise<{ sessionId: string }> {
    const pending = takePendingBigQueryOauth(params.state);
    if (!pending) {
      throw new AppError('AUTH_FAILED', 'This Google sign-in link has expired or is invalid. Try again.');
    }
    const session = getSession(pending.sessionId);
    if (!session) {
      throw new AppError('AUTH_REQUIRED', 'Your session expired during Google sign-in. Unlock your vault and retry.');
    }
    const token = await BigQueryOauth.exchangeCodeForToken({
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      redirectUri: pending.redirectUri,
      code: params.code,
      codeVerifier: pending.codeVerifier,
    });
    const email = await BigQueryOauth.fetchUserEmail(token.accessToken);
    session.connectors = {
      ...(session.connectors ?? {}),
      bigquery: {
        email,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
      },
    };
    return { sessionId: session.id };
  },

  /** Whether a BigQuery OAuth session is active for this session (+ the signed-in email). */
  bigQueryConnected(session: Session): { connected: boolean; email?: string } {
    const bq = session.connectors?.bigquery;
    return { connected: Boolean(bq?.accessToken), email: bq?.email };
  },

  /** List the signed-in account's GCP projects (billing + data project pickers). */
  async bigQueryListProjects(session: Session): Promise<BigQuery.BigQueryProject[]> {
    requireAuth(session);
    return BigQuery.listProjects(await bigQueryAuth(session));
  },

  /** List datasets in a BigQuery data project. */
  async bigQueryListDatasets(session: Session, projectId: string): Promise<BigQuery.BigQueryDataset[]> {
    requireAuth(session);
    return BigQuery.listDatasets(await bigQueryAuth(session), projectId);
  },

  /** List tables/views in a BigQuery dataset. */
  async bigQueryListTables(
    session: Session,
    projectId: string,
    datasetId: string,
  ): Promise<BigQuery.BigQueryTable[]> {
    requireAuth(session);
    return BigQuery.listTables(await bigQueryAuth(session), projectId, datasetId);
  },

  /**
   * Describe a BigQuery table's scalar columns (name/type) for the relationship builder's
   * join-field dropdowns. Returns non-secret field identity only.
   */
  async bigQueryDescribeTable(
    session: Session,
    projectId: string,
    datasetId: string,
    tableId: string,
  ): Promise<Array<{ name: string; label: string; type: string }>> {
    requireAuth(session);
    const fields = await BigQuery.describeTable(await bigQueryAuth(session), projectId, datasetId, tableId);
    return fields.map((f) => ({ name: f.name, label: f.name, type: f.type }));
  },

  /**
   * Build a BigQuery datasource (single table, or multiple tables joined via relationships /
   * physical join) and publish it to the given Tableau Cloud project, then lock it as the
   * session's source of truth.
   *
   * `materialization: 'live'` publishes a bare `.tds` that queries BigQuery directly over
   * OAuth (no `<extract>`); nothing runs afterwards. `materialization: 'extract'` queries
   * the selected tables' rows, materializes them into a local `.hyper` (Python Hyper
   * sidecar), publishes the packaged `.tdsx`, then (best-effort) embeds the OAuth credential
   * and kicks off a server-side extract refresh on Tableau Cloud. Both forms embed the
   * signed-in Google account's saved OAuth credential so the datasource is connectable.
   */
  async buildAndPublishBigQueryDatasource(
    session: Session,
    input: {
      billingProjectId: string;
      dataProjectId: string;
      dataProjectName: string;
      datasetId: string;
      tables: string[];
      relationships?: BigQueryRelationshipSpec[];
      mode?: 'relationship' | 'join';
      materialization?: BigQueryMaterialization;
      projectId: string;
      datasourceName: string;
      overwrite?: boolean;
    },
  ): Promise<{
    datasource: TableauDatasource;
    lock: DatasourceLock;
    projectContext: TableauProjectContext;
    extract: ExtractResult;
  }> {
    requireAuth(session);
    const bq = session.connectors?.bigquery;
    if (!bq?.accessToken) {
      throw new AppError('CONNECTOR_API', 'Not signed in to Google BigQuery. Sign in first, then select tables.');
    }
    const username = bq.email; // connection username + saved-credential match (captured before clearing state)

    const tables = (input.tables ?? []).map((t) => String(t ?? '').trim());
    if (tables.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one BigQuery table to build a datasource.');
    }
    if (new Set(tables).size !== tables.length) {
      throw new AppError('VALIDATION', 'Duplicate BigQuery tables are not allowed.');
    }

    const project = (await this.listProjects(session)).find((p) => p.id === input.projectId);
    if (!project) {
      throw new AppError('NOT_FOUND', 'Target project not found among your accessible projects.');
    }

    const auth = await bigQueryAuth(session);
    const maxRows = getConfig().hyper.maxRows;
    const materialization: BigQueryMaterialization = input.materialization ?? 'extract';
    const isExtract = materialization === 'extract';
    const relationships = input.relationships ?? [];

    // Describe every table (and, for an extract, pull its rows for the local `.hyper`).
    const described: Array<{ table: string; fields: BigQueryField[]; rows: Array<Array<unknown>> }> = [];
    for (const table of tables) {
      const fields = await BigQuery.describeTable(auth, input.dataProjectId, input.datasetId, table);
      if (fields.length === 0) {
        throw new AppError('CONNECTOR_API', `BigQuery table "${table}" exposes no scalar columns to model.`);
      }
      const rows = isExtract
        ? await BigQuery.queryRows(auth, {
            billingProjectId: input.billingProjectId,
            projectId: input.dataProjectId,
            datasetId: input.datasetId,
            tableId: table,
            fields,
            maxRows,
          })
        : [];
      described.push({ table, fields, rows });
    }

    // Validate every relationship's join fields exist on the respective tables.
    const fieldSetByTable = new Map(described.map((d) => [d.table, new Set(d.fields.map((f) => f.name))]));
    for (const r of relationships) {
      if (!fieldSetByTable.get(r.leftTable)?.has(r.leftField)) {
        throw new AppError('VALIDATION', `Join field "${r.leftField}" was not found on table "${r.leftTable}".`);
      }
      if (!fieldSetByTable.get(r.rightTable)?.has(r.rightField)) {
        throw new AppError('VALIDATION', `Join field "${r.rightField}" was not found on table "${r.rightTable}".`);
      }
    }

    const conn: BigQueryConnectionInfo = {
      billingProjectId: input.billingProjectId,
      dataProjectId: input.dataProjectId,
      dataProjectName: input.dataProjectName,
      datasetId: input.datasetId,
      username,
    };
    const tableSpecs: BigQueryTableSpec[] = described.map((d) => ({
      table: d.table,
      columns: d.fields.map((f) => ({ name: f.name, bqType: f.type, nillable: f.nillable })),
    }));
    const isMulti = described.length > 1;
    const mode = input.mode ?? 'relationship';

    // Extract packaging path (only used when materialization === 'extract').
    const hyperName = `federated_${randomBytes(10).toString('hex')}.hyper`;
    const hyperDbname = `Data/Extracts/${hyperName}`;
    const extract = isExtract ? { hyperDbname } : undefined;

    let tdsXml: string;
    if (isMulti) {
      const relInput = {
        datasourceName: input.datasourceName,
        connection: conn,
        materialization,
        tables: tableSpecs,
        relationships,
        extract,
      };
      tdsXml =
        mode === 'join' ? generateBigQueryPhysicalJoinTds(relInput) : generateBigQueryRelationshipsTds(relInput);
    } else {
      tdsXml = generateBigQueryTds({
        datasourceName: input.datasourceName,
        connection: conn,
        materialization,
        table: described[0]!.table,
        columns: tableSpecs[0]!.columns,
        extract,
      });
    }

    // Publish: a packaged `.tdsx` (extract) or a bare `.tds` (live). BOTH embed the signed-in
    // Google account's saved OAuth credential so the datasource is connectable on Tableau Cloud.
    let published;
    if (isExtract) {
      const extractTables: ExtractTable[] = described.map((d) => ({
        object: bigQueryObjectId(d.table),
        schema: d.fields.map((f) => ({ name: f.name, type: bigQueryToHyperType(f.type) })) as ExtractColumn[],
        rows: d.rows,
      }));
      const tdsxBuffer = await buildExtractTdsx({ tdsXml, hyperName, tables: extractTables });
      published = await publishDatasource(getClient(session), {
        siteId: siteId(session),
        projectId: project.id,
        datasourceName: input.datasourceName,
        tdsxBuffer,
        overwrite: input.overwrite,
        connectionCredentials: { name: username, oAuth: true, embed: true },
      });
    } else {
      published = await publishDatasource(getClient(session), {
        siteId: siteId(session),
        projectId: project.id,
        datasourceName: input.datasourceName,
        tdsXml,
        overwrite: input.overwrite,
        connectionCredentials: { name: username, oAuth: true, embed: true },
      });
    }

    this.setProjectContext(session, { siteId: siteId(session), projectId: project.id, projectName: project.name });

    const ds: TableauDatasource = {
      id: published.id,
      name: published.name,
      contentUrl: published.contentUrl,
      projectId: published.projectId,
      projectName: published.projectName,
    };
    const lock = this.lockDatasource(session, ds);

    // Cache the field identities so the dashboard flow has real fields immediately, matching
    // the published datasource's disambiguated column names.
    session.flow.connectorMetadata = {
      ...(session.flow.connectorMetadata ?? {}),
      [ds.id]: bigQueryTablesToMetadata(ds.id, ds.name, tableSpecs),
    };

    // Discard the transient BigQuery OAuth state now that publishing is complete.
    session.connectors = undefined;

    // Embed the saved Google OAuth credential on the published connection(s) (matched by
    // email) so the datasource is connectable / refreshable. Best-effort — a failure must NOT
    // fail the publish (a live datasource is already published; an extract already has data).
    try {
      const conns = await listDatasourceConnections(getClient(session), siteId(session), ds.id);
      for (const c of conns) {
        await embedDatasourceConnectionCredential(getClient(session), siteId(session), ds.id, c.id, {
          userName: username,
        });
      }
    } catch (err) {
      log.warn('Could not embed saved Google credential on datasource connection after publish', {
        datasourceId: ds.id,
        error: err instanceof AppError ? err.message : String(err),
      });
    }

    // LIVE: nothing further — Tableau queries BigQuery directly. EXTRACT: kick off a
    // server-side "Update Data Source Now" so Tableau Cloud rebuilds the extract from the
    // live BigQuery connection using the embedded credential. Best-effort.
    let refreshNote = '';
    if (isExtract) {
      try {
        const { jobId } = await refreshDatasourceNow(getClient(session), siteId(session), ds.id);
        refreshNote = jobId
          ? ` Started a server-side extract refresh (job ${jobId}).`
          : ' Started a server-side extract refresh.';
      } catch (err) {
        log.warn('Could not start BigQuery extract refresh after publish', {
          datasourceId: ds.id,
          error: err instanceof AppError ? err.message : String(err),
        });
        refreshNote =
          ' Note: could not start the extract refresh automatically — verify your saved Google BigQuery credential on Tableau Cloud, then use "Refresh Extracts" on the datasource.';
      }
    }

    const tableSummary = isMulti ? ` across ${described.length} tables` : '';
    let message: string;
    if (isExtract) {
      const totalRows = described.reduce((sum, d) => sum + d.rows.length, 0);
      const anyCapped = described.some((d) => d.rows.length >= maxRows);
      message =
        `Extract built with ${totalRows.toLocaleString()} row(s)${tableSummary}` +
        `${anyCapped ? ` (some tables capped at ${maxRows.toLocaleString()})` : ''}.${refreshNote}`;
    } else {
      message = `Published a LIVE BigQuery datasource${tableSummary}. Tableau Cloud queries BigQuery directly over OAuth.`;
    }
    const extractResult: ExtractResult = { state: 'succeeded', message };
    return { datasource: ds, lock, projectContext: session.flow.projectContext!, extract: extractResult };
  },

  /**
   * Connect to Salesforce Data Cloud: SOAP login (imported Salesforce.login) + CDP token
   * exchange. The live sessions are stored transiently on the session so subsequent list /
   * describe / publish calls can use them. Nothing is logged.
   */
  async dataCloudConnect(session: Session, creds: SalesforceCredentials): Promise<{ connected: true }> {
    requireAuth(session);
    const { sfSession, cdp } = await DataCloud.connect(creds);
    session.connectors = {
      ...(session.connectors ?? {}),
      datacloud: { creds, sfSession, cdp },
    };
    return { connected: true };
  },

  /** List Data Cloud data spaces visible to the signed-in user. */
  async dataCloudListDataSpaces(session: Session): Promise<DataCloud.DataCloudDataSpace[]> {
    requireAuth(session);
    return DataCloud.listDataSpaces(dataCloudAuth(session));
  },

  /** List Data Cloud objects in a data space, filterable by category (DMO / DLO / CI / all). */
  async dataCloudListObjects(
    session: Session,
    dataSpace: string,
    category: DataCloudObjectCategory = 'all',
  ): Promise<DataCloud.DataCloudObject[]> {
    requireAuth(session);
    return DataCloud.listObjects(await dataCloudAuthForSpace(session, dataSpace), dataSpace, category);
  },

  /**
   * Describe a Data Cloud object's scalar columns (name/label/type) for the relationship
   * builder's join-field dropdowns. Returns non-secret field identity only.
   */
  async dataCloudDescribeObject(
    session: Session,
    dataSpace: string,
    objectName: string,
  ): Promise<Array<{ name: string; label: string; type: string }>> {
    requireAuth(session);
    const fields = await DataCloud.describeObject(
      await dataCloudAuthForSpace(session, dataSpace),
      dataSpace,
      objectName,
    );
    return fields.map((f) => ({ name: f.name, label: f.label, type: f.type }));
  },

  /**
   * Build a Salesforce Data Cloud (Genie) datasource (single object, or multiple objects
   * joined via relationships / physical join) and publish it to the given Tableau Cloud
   * project, then lock it as the session's source of truth.
   *
   * `materialization: 'live'` publishes a bare `.tds` (`class='salesforce-genie'`, no
   * `<extract>`); nothing runs afterwards. `materialization: 'extract'` queries the selected
   * objects' rows, materializes them into a local `.hyper` (Python Hyper sidecar), publishes
   * the packaged `.tdsx`, then (best-effort) embeds the saved Data Cloud OAuth credential and
   * kicks off a server-side extract refresh. Both forms embed the Salesforce username so the
   * datasource matches the publisher's saved Salesforce Data Cloud OAuth credential.
   */
  async buildAndPublishDataCloudDatasource(
    session: Session,
    input: {
      credentials: SalesforceCredentials;
      dataSpace: string;
      category?: DataCloudObjectCategory;
      tables: string[];
      relationships?: DataCloudRelationshipSpec[];
      mode?: SalesforceBuildMode;
      materialization?: DataCloudMaterialization;
      projectId: string;
      datasourceName: string;
      overwrite?: boolean;
    },
  ): Promise<{
    datasource: TableauDatasource;
    lock: DatasourceLock;
    projectContext: TableauProjectContext;
    extract: ExtractResult;
  }> {
    requireAuth(session);
    let dc = session.connectors?.datacloud;
    if (!dc?.cdp?.accessToken) {
      const connected = await DataCloud.connect(input.credentials);
      dc = { creds: input.credentials, sfSession: connected.sfSession, cdp: connected.cdp };
      session.connectors = { ...(session.connectors ?? {}), datacloud: dc };
    }
    const username = dc.creds.username;
    const auth = await dataCloudAuthForSpace(session, input.dataSpace);

    const tables = (input.tables ?? []).map((t) => String(t ?? '').trim());
    if (tables.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one Data Cloud object to build a datasource.');
    }
    if (new Set(tables).size !== tables.length) {
      throw new AppError('VALIDATION', 'Duplicate Data Cloud objects are not allowed.');
    }

    const project = (await this.listProjects(session)).find((p) => p.id === input.projectId);
    if (!project) {
      throw new AppError('NOT_FOUND', 'Target project not found among your accessible projects.');
    }

    const maxRows = getConfig().hyper.maxRows;
    const materialization: DataCloudMaterialization = input.materialization ?? 'extract';
    const isExtract = materialization === 'extract';
    const relationships = input.relationships ?? [];

    const listed = await DataCloud.listObjects(auth, input.dataSpace, input.category ?? 'all').catch(
      (): DataCloud.DataCloudObject[] => [],
    );
    const captionByName = new Map(listed.map((o) => [o.name, o.label]));

    const described: Array<{
      object: string;
      caption: string;
      fields: DataCloudField[];
      rows: Array<Array<unknown>>;
    }> = [];
    for (const object of tables) {
      const fields = await DataCloud.describeObject(auth, input.dataSpace, object);
      if (fields.length === 0) {
        throw new AppError('CONNECTOR_API', `Data Cloud object "${object}" exposes no scalar columns to model.`);
      }
      const caption = captionByName.get(object) ?? object;
      const rows = isExtract
        ? await DataCloud.queryRows(auth, {
            dataSpace: input.dataSpace,
            objectName: object,
            fields,
            maxRows,
          })
        : [];
      described.push({ object, caption, fields, rows });
    }

    const fieldSetByObject = new Map(described.map((d) => [d.object, new Set(d.fields.map((f) => f.name))]));
    for (const r of relationships) {
      if (!fieldSetByObject.get(r.leftObject)?.has(r.leftField)) {
        throw new AppError('VALIDATION', `Join field "${r.leftField}" was not found on object "${r.leftObject}".`);
      }
      if (!fieldSetByObject.get(r.rightObject)?.has(r.rightField)) {
        throw new AppError('VALIDATION', `Join field "${r.rightField}" was not found on object "${r.rightObject}".`);
      }
    }

    const conn: DataCloudConnectionInfo = {
      instanceUrl: dc.sfSession.instanceUrl.replace(/\/+$/, ''),
      server: auth.instanceUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
      username,
      dataSpace: input.dataSpace,
      tenantId: auth.tenantId,
      pod: auth.pod,
    };
    const tableSpecs: DataCloudTableSpec[] = described.map((d) => ({
      object: d.object,
      caption: d.caption,
      columns: d.fields.map((f) => ({ name: f.name, dcType: f.type, nillable: f.nillable })),
    }));
    const isMulti = described.length > 1;
    const mode = input.mode ?? 'relationship';

    const hyperName = `federated_${randomBytes(10).toString('hex')}.hyper`;
    const hyperDbname = `Data/Extracts/${hyperName}`;
    const extract = isExtract ? { hyperDbname } : undefined;

    let tdsXml: string;
    if (isMulti) {
      const relInput = {
        datasourceName: input.datasourceName,
        connection: conn,
        materialization,
        tables: tableSpecs,
        relationships,
        extract,
      };
      tdsXml =
        mode === 'join'
          ? generateDataCloudPhysicalJoinTds(relInput)
          : generateDataCloudRelationshipsTds(relInput);
    } else {
      tdsXml = generateDataCloudTds({
        datasourceName: input.datasourceName,
        connection: conn,
        materialization,
        object: described[0]!.object,
        caption: described[0]!.caption,
        columns: tableSpecs[0]!.columns,
        extract,
      });
    }

    let published;
    if (isExtract) {
      const extractTables: ExtractTable[] = described.map((d) => ({
        object: dataCloudObjectId(d.caption, d.object),
        schema: d.fields.map((f) => ({ name: f.name, type: dataCloudToHyperType(f.type) })) as ExtractColumn[],
        rows: d.rows,
      }));
      const tdsxBuffer = await buildExtractTdsx({ tdsXml, hyperName, tables: extractTables });
      published = await publishDatasource(getClient(session), {
        siteId: siteId(session),
        projectId: project.id,
        datasourceName: input.datasourceName,
        tdsxBuffer,
        overwrite: input.overwrite,
        connectionCredentials: { name: username, oAuth: true, embed: true },
      });
    } else {
      published = await publishDatasource(getClient(session), {
        siteId: siteId(session),
        projectId: project.id,
        datasourceName: input.datasourceName,
        tdsXml,
        overwrite: input.overwrite,
        connectionCredentials: { name: username, oAuth: true, embed: true },
      });
    }

    this.setProjectContext(session, { siteId: siteId(session), projectId: project.id, projectName: project.name });

    const ds: TableauDatasource = {
      id: published.id,
      name: published.name,
      contentUrl: published.contentUrl,
      projectId: published.projectId,
      projectName: published.projectName,
    };
    const lock = this.lockDatasource(session, ds);

    session.flow.connectorMetadata = {
      ...(session.flow.connectorMetadata ?? {}),
      [ds.id]: dataCloudTablesToMetadata(ds.id, ds.name, tableSpecs),
    };

    session.connectors = undefined;

    try {
      const conns = await listDatasourceConnections(getClient(session), siteId(session), ds.id);
      for (const c of conns) {
        await embedDatasourceConnectionCredential(getClient(session), siteId(session), ds.id, c.id, {
          userName: username,
        });
      }
    } catch (err) {
      log.warn('Could not embed saved Data Cloud credential on datasource connection after publish', {
        datasourceId: ds.id,
        error: err instanceof AppError ? err.message : String(err),
      });
    }

    let refreshNote = '';
    if (isExtract) {
      try {
        const { jobId } = await refreshDatasourceNow(getClient(session), siteId(session), ds.id);
        refreshNote = jobId
          ? ` Started a server-side extract refresh (job ${jobId}).`
          : ' Started a server-side extract refresh.';
      } catch (err) {
        log.warn('Could not start Data Cloud extract refresh after publish', {
          datasourceId: ds.id,
          error: err instanceof AppError ? err.message : String(err),
        });
        refreshNote =
          ' Note: could not start the extract refresh automatically — verify your saved Salesforce Data Cloud credential on Tableau Cloud, then use "Refresh Extracts" on the datasource.';
      }
    }

    const tableSummary = isMulti ? ` across ${described.length} objects` : '';
    let message: string;
    if (isExtract) {
      const totalRows = described.reduce((sum, d) => sum + d.rows.length, 0);
      const anyCapped = described.some((d) => d.rows.length >= maxRows);
      message =
        `Extract built with ${totalRows.toLocaleString()} row(s)${tableSummary}` +
        `${anyCapped ? ` (some objects capped at ${maxRows.toLocaleString()})` : ''}.${refreshNote}`;
    } else {
      message = `Published a LIVE Salesforce Data Cloud datasource${tableSummary}. Tableau Cloud queries Data Cloud directly over OAuth.`;
    }
    const extractResult: ExtractResult = { state: 'succeeded', message };
    return { datasource: ds, lock, projectContext: session.flow.projectContext!, extract: extractResult };
  },

  /**
   * Connect to Snowflake with username/password. The live session + credentials are
   * stored transiently on the (memory-only) session so listing and publish can reuse them.
   */
  async snowflakeConnect(
    session: Session,
    creds: SnowflakeCredentials,
  ): Promise<{ connected: true; warehouse: string; host: string }> {
    requireAuth(session);
    const auth = await Snowflake.connect(creds);
    session.connectors = { ...(session.connectors ?? {}), snowflake: { creds, auth } };
    return { connected: true, warehouse: auth.warehouse, host: auth.host };
  },

  async snowflakeListWarehouses(session: Session): Promise<Array<{ name: string; label: string }>> {
    requireAuth(session);
    return Snowflake.listWarehouses(snowflakeAuth(session));
  },

  async snowflakeListDatabases(
    session: Session,
    warehouse: string,
  ): Promise<Array<{ name: string; label: string }>> {
    requireAuth(session);
    return Snowflake.listDatabases(snowflakeAuth(session), warehouse);
  },

  async snowflakeListSchemas(
    session: Session,
    warehouse: string,
    database: string,
  ): Promise<Array<{ name: string; label: string }>> {
    requireAuth(session);
    return Snowflake.listSchemas(snowflakeAuth(session), warehouse, database);
  },

  async snowflakeListTables(
    session: Session,
    warehouse: string,
    database: string,
    schema: string,
  ): Promise<Array<{ name: string; label: string }>> {
    requireAuth(session);
    return Snowflake.listTables(snowflakeAuth(session), warehouse, database, schema);
  },

  async snowflakeDescribeTable(
    session: Session,
    warehouse: string,
    database: string,
    schema: string,
    table: string,
  ): Promise<Array<{ name: string; label: string; type: string }>> {
    requireAuth(session);
    const fields = await Snowflake.describeTable(snowflakeAuth(session), warehouse, database, schema, table);
    return fields.map((f) => ({ name: f.name, label: f.label, type: f.type }));
  },

  /**
   * Build a Snowflake datasource (single table, or multiple tables joined via
   * relationships / physical join) and publish it to the given Tableau Cloud project,
   * then lock it as the session's source of truth.
   *
   * `materialization: 'live'` publishes a bare `.tds` (`class='snowflake'`, Username
   * Password, no `<extract>`); nothing runs afterwards. `materialization: 'extract'`
   * queries the selected tables' rows, materializes them into a local `.hyper`, publishes
   * the packaged `.tdsx`, then (best-effort) kicks off a server-side extract refresh.
   * Both forms embed the Snowflake username/password on the published connection.
   */
  async buildAndPublishSnowflakeDatasource(
    session: Session,
    input: {
      credentials: SnowflakeCredentials;
      warehouse: string;
      database: string;
      schema: string;
      tables: string[];
      relationships?: SnowflakeRelationshipSpec[];
      mode?: SalesforceBuildMode;
      materialization?: SnowflakeMaterialization;
      projectId: string;
      datasourceName: string;
      overwrite?: boolean;
    },
  ): Promise<{
    datasource: TableauDatasource;
    lock: DatasourceLock;
    projectContext: TableauProjectContext;
    extract: ExtractResult;
  }> {
    requireAuth(session);
    let sf = session.connectors?.snowflake;
    if (!sf?.auth?.token) {
      const auth = await Snowflake.connect(input.credentials);
      sf = { creds: input.credentials, auth };
      session.connectors = { ...(session.connectors ?? {}), snowflake: sf };
    }
    const username = sf.creds.username;
    const password = sf.creds.password;
    const auth = sf.auth;

    const tables = (input.tables ?? []).map((t) => String(t ?? '').trim());
    if (tables.length === 0) {
      throw new AppError('VALIDATION', 'Select at least one Snowflake table to build a datasource.');
    }
    if (new Set(tables).size !== tables.length) {
      throw new AppError('VALIDATION', 'Duplicate Snowflake tables are not allowed.');
    }

    const project = (await this.listProjects(session)).find((p) => p.id === input.projectId);
    if (!project) {
      throw new AppError('NOT_FOUND', 'Target project not found among your accessible projects.');
    }

    const maxRows = getConfig().hyper.maxRows;
    const materialization: SnowflakeMaterialization = input.materialization ?? 'extract';
    const isExtract = materialization === 'extract';
    const relationships = input.relationships ?? [];

    const described: Array<{ table: string; fields: SnowflakeField[]; rows: Array<Array<unknown>> }> = [];
    for (const table of tables) {
      const fields = await Snowflake.describeTable(auth, input.warehouse, input.database, input.schema, table);
      if (fields.length === 0) {
        throw new AppError('CONNECTOR_API', `Snowflake table "${table}" exposes no scalar columns to model.`);
      }
      const rows = isExtract
        ? await Snowflake.queryRows(auth, {
            warehouse: input.warehouse,
            database: input.database,
            schema: input.schema,
            table,
            fields,
            maxRows,
          })
        : [];
      described.push({ table, fields, rows });
    }

    const fieldSetByTable = new Map(described.map((d) => [d.table, new Set(d.fields.map((f) => f.name))]));
    for (const r of relationships) {
      if (!fieldSetByTable.get(r.leftTable)?.has(r.leftField)) {
        throw new AppError('VALIDATION', `Join field "${r.leftField}" was not found on table "${r.leftTable}".`);
      }
      if (!fieldSetByTable.get(r.rightTable)?.has(r.rightField)) {
        throw new AppError('VALIDATION', `Join field "${r.rightField}" was not found on table "${r.rightTable}".`);
      }
    }

    const conn: SnowflakeConnectionInfo = {
      server: auth.host,
      database: input.database,
      schema: input.schema,
      warehouse: input.warehouse,
      username,
    };
    const tableSpecs: SnowflakeTableSpec[] = described.map((d) => ({
      table: d.table,
      columns: d.fields.map((f) => ({ name: f.name, sfType: f.type, nillable: f.nillable })),
    }));
    const isMulti = described.length > 1;
    const mode = input.mode ?? 'relationship';

    const hyperName = `federated_${randomBytes(10).toString('hex')}.hyper`;
    const hyperDbname = `Data/Extracts/${hyperName}`;
    const extract = isExtract ? { hyperDbname } : undefined;

    let tdsXml: string;
    if (isMulti) {
      const relInput = {
        datasourceName: input.datasourceName,
        connection: conn,
        materialization,
        tables: tableSpecs,
        relationships,
        extract,
      };
      tdsXml =
        mode === 'join' ? generateSnowflakePhysicalJoinTds(relInput) : generateSnowflakeRelationshipsTds(relInput);
    } else {
      tdsXml = generateSnowflakeTds({
        datasourceName: input.datasourceName,
        connection: conn,
        materialization,
        table: described[0]!.table,
        columns: tableSpecs[0]!.columns,
        extract,
      });
    }

    const connectionCredentials = { name: username, password, embed: true as const };

    let published;
    if (isExtract) {
      const extractTables: ExtractTable[] = described.map((d) => ({
        object: snowflakeObjectId(input.database, input.schema, d.table),
        schema: d.fields.map((f) => ({ name: f.name, type: snowflakeToHyperType(f.type) })) as ExtractColumn[],
        rows: d.rows,
      }));
      const tdsxBuffer = await buildExtractTdsx({ tdsXml, hyperName, tables: extractTables });
      published = await publishDatasource(getClient(session), {
        siteId: siteId(session),
        projectId: project.id,
        datasourceName: input.datasourceName,
        tdsxBuffer,
        overwrite: input.overwrite,
        connectionCredentials,
      });
    } else {
      published = await publishDatasource(getClient(session), {
        siteId: siteId(session),
        projectId: project.id,
        datasourceName: input.datasourceName,
        tdsXml,
        overwrite: input.overwrite,
        connectionCredentials,
      });
    }

    this.setProjectContext(session, { siteId: siteId(session), projectId: project.id, projectName: project.name });

    const ds: TableauDatasource = {
      id: published.id,
      name: published.name,
      contentUrl: published.contentUrl,
      projectId: published.projectId,
      projectName: published.projectName,
    };
    const lock = this.lockDatasource(session, ds);

    session.flow.connectorMetadata = {
      ...(session.flow.connectorMetadata ?? {}),
      [ds.id]: snowflakeTablesToMetadata(ds.id, ds.name, input.database, input.schema, tableSpecs),
    };

    session.connectors = undefined;

    let refreshNote = '';
    if (isExtract) {
      try {
        const { jobId } = await refreshDatasourceNow(getClient(session), siteId(session), ds.id);
        refreshNote = jobId
          ? ` Started a server-side extract refresh (job ${jobId}).`
          : ' Started a server-side extract refresh.';
      } catch (err) {
        log.warn('Could not start Snowflake extract refresh after publish', {
          datasourceId: ds.id,
          error: err instanceof AppError ? err.message : String(err),
        });
        refreshNote =
          ' Note: could not start the extract refresh automatically — verify the embedded Snowflake credentials on Tableau Cloud, then use "Refresh Extracts" on the datasource.';
      }
    }

    const tableSummary = isMulti ? ` across ${described.length} tables` : '';
    let message: string;
    if (isExtract) {
      const totalRows = described.reduce((sum, d) => sum + d.rows.length, 0);
      const anyCapped = described.some((d) => d.rows.length >= maxRows);
      message =
        `Extract built with ${totalRows.toLocaleString()} row(s)${tableSummary}` +
        `${anyCapped ? ` (some tables capped at ${maxRows.toLocaleString()})` : ''}.${refreshNote}`;
    } else {
      message = `Published a LIVE Snowflake datasource${tableSummary}. Tableau Cloud queries Snowflake directly.`;
    }
    const extractResult: ExtractResult = { state: 'succeeded', message };
    return { datasource: ds, lock, projectContext: session.flow.projectContext!, extract: extractResult };
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
