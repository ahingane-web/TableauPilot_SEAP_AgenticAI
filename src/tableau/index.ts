/**
 * TableauService — the single façade the rest of the app (Mastra tools, workflows,
 * API routes) uses to talk to Tableau Cloud. It operates on a server-side Session:
 * it signs in with the vault's PAT, caches the live REST token in memory, and
 * exposes high-level operations. No Tableau HTTP happens outside this layer.
 */
import type { DashboardPlan } from '../schemas/dashboardPlan.js';
import type { DatasourceLock, TableauProjectContext } from '../schemas/common.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertApproved, assertDatasourceLock, assertProjectMatch } from '../validation/guards.js';
import { VaultService } from '../vault/vault.js';
import type { Session } from '../vault/session.js';
import { mintConnectedAppJwt, signIn } from './auth/index.js';
import { generateTwb } from './authoring/twbGenerator.js';
import { buildNewWorkbookAuthoringUrl, buildWebEditUrl } from './authoring/index.js';
import { getDatasourceMetadata } from './datasources/index.js';
import {
  getProjects,
  getPublishedDatasources,
  getViews,
  getWorkbooks,
} from './discovery/index.js';
import {
  checkDatasourceAccess,
  checkProjectPublishPermission,
  checkWorkbookEditPermission,
} from './permissions/index.js';
import { publishWorkbook } from './publishing/index.js';
import { TableauClient } from './tableauClient.js';
import { verifyWorkbook } from './verification/index.js';
import type {
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

function siteId(session: Session): string {
  return requireAuth(session).siteId;
}

function requireAuth(session: Session) {
  if (!session.tableauAuth) throw new AppError('AUTH_REQUIRED', 'Not connected to Tableau Cloud. Connect first.');
  return session.tableauAuth;
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

    const twb = generateTwb(plan, metadata);
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
  },

  /** Verify a published workbook actually exists in the expected project + resolve URL. */
  async verify(session: Session, workbookId: string, expected: { projectId?: string; dashboardName?: string }): Promise<WorkbookVerification> {
    return verifyWorkbook(getClient(session), siteId(session), workbookId, expected);
  },

  /**
   * Build embedded Web Authoring info: a short-lived Connected App JWT (if
   * configured) plus the real authoring URL. Returns `requiresInteractiveLogin`
   * when no Connected App is configured (the embed then shows Tableau's own login).
   */
  getEmbedInfo(session: Session, opts: { mode: 'new_workbook' | 'existing_workbook'; datasource?: TableauDatasource; view?: TableauView; workbook?: TableauWorkbook }): {
    src?: string;
    token?: string;
    tokenExpiresAt?: number;
    requiresInteractiveLogin: boolean;
    embeddingLibraryUrl: string;
  } {
    const auth = requireAuth(session);
    const creds = VaultService.getCredentials(session);
    const embeddingLibraryUrl = `${auth.serverUrl.replace(/\/+$/, '')}/javascripts/api/tableau.embedding.3.latest.min.js`;

    let src: string | undefined;
    if (opts.mode === 'new_workbook' && opts.datasource) {
      src = buildNewWorkbookAuthoringUrl({
        serverUrl: auth.serverUrl,
        siteContentUrl: auth.siteContentUrl,
        datasourceContentUrl: opts.datasource.contentUrl,
        datasourceId: opts.datasource.id,
      });
    } else {
      src = buildWebEditUrl({
        serverUrl: auth.serverUrl,
        siteContentUrl: auth.siteContentUrl,
        view: opts.view,
        workbook: opts.workbook,
      });
    }

    if (creds.connectedApp?.secretValue) {
      const { token, expiresAt } = mintConnectedAppJwt(creds, { username: auth.userId || creds.patName });
      return { src, token, tokenExpiresAt: expiresAt, requiresInteractiveLogin: false, embeddingLibraryUrl };
    }
    return { src, requiresInteractiveLogin: true, embeddingLibraryUrl };
  },
};

export type { DatasourceMetadata, PermissionResult, PublishResult, WorkbookVerification } from './types.js';
