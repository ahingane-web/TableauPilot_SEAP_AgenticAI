/**
 * Publishing verification.
 *
 * A 2xx from the publish call is NOT proof of success. After publishing we re-query
 * Tableau Cloud to confirm the workbook truly exists in the expected site/project,
 * enumerate its views (the dashboard), inspect its connected datasources, and
 * resolve the ACTUAL Tableau Cloud URL. Only after this do we report success.
 * URLs are taken from Tableau responses — never guessed.
 */
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { getWorkbookViews } from '../discovery/index.js';
import type { TableauClient } from '../tableauClient.js';
import type { WorkbookVerification } from '../types.js';

const log = logger.child('verification');

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export async function verifyWorkbook(
  client: TableauClient,
  siteId: string,
  workbookId: string,
  expected: { projectId?: string; dashboardName?: string },
): Promise<WorkbookVerification> {
  let wb: any;
  try {
    const body = await client.get<any>(`/sites/${siteId}/workbooks/${workbookId}`);
    wb = body?.workbook;
  } catch {
    throw new AppError('VERIFICATION_FAILED', 'Could not read the published workbook back from Tableau Cloud.', {
      details: { workbookId },
    });
  }
  if (!wb?.id) {
    return {
      exists: false,
      workbookId,
      name: '',
      siteId,
      views: [],
      connectedDatasourceIds: [],
    };
  }

  const views = await getWorkbookViews(client, siteId, workbookId).catch(() => []);
  const connectedDatasourceIds = await getConnectedDatasourceIds(client, siteId, workbookId);

  // Prefer the view URL for the requested dashboard if we can find it; otherwise the workbook URL.
  const dashView = expected.dashboardName
    ? views.find((v) => v.name === expected.dashboardName)
    : undefined;
  const url = resolveUrl(wb, dashView?.contentUrl, client.serverUrl, wb.contentUrl);

  const result: WorkbookVerification = {
    exists: true,
    workbookId: wb.id,
    name: wb.name,
    siteId,
    projectId: wb.project?.id,
    projectName: wb.project?.name,
    contentUrl: wb.contentUrl,
    webpageUrl: wb.webpageUrl,
    views,
    url,
    connectedDatasourceIds,
  };

  if (expected.projectId && result.projectId && expected.projectId !== result.projectId) {
    throw new AppError('VERIFICATION_FAILED', 'Published workbook landed in a different project than approved.', {
      details: { expectedProjectId: expected.projectId, actualProjectId: result.projectId },
    });
  }
  log.info('Workbook verified', { workbookId: result.workbookId, views: views.length });
  return result;
}

async function getConnectedDatasourceIds(client: TableauClient, siteId: string, workbookId: string): Promise<string[]> {
  try {
    const body = await client.get<any>(`/sites/${siteId}/workbooks/${workbookId}/connections`);
    return toArray<any>(body?.connections?.connection)
      .map((c) => c?.datasource?.id)
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

/** Resolve the real URL, preferring Tableau-provided values. */
function resolveUrl(wb: any, viewContentUrl: string | undefined, _serverUrl: string, _workbookContentUrl?: string): string | undefined {
  if (viewContentUrl) {
    const path = viewContentUrl.replace(/\/sheets\//, '/');
    // Reuse the workbook webpageUrl origin/site if available for correctness.
    if (wb?.webpageUrl) {
      const origin = wb.webpageUrl.split('/#/')[0];
      const siteSeg = wb.webpageUrl.match(/\/#\/site\/([^/]+)\//)?.[1];
      if (origin && siteSeg) return `${origin}/#/site/${siteSeg}/views/${path}`;
    }
  }
  return wb?.webpageUrl;
}
