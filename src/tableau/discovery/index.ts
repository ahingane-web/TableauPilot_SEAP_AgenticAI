/**
 * Tableau Cloud resource discovery.
 *
 * Everything here is dynamic — sites, projects, workbooks, views, and published
 * datasources are read from the user's live Tableau Cloud site. Nothing is
 * hardcoded. All functions page through results up to a sane cap.
 */
import type { TableauClient } from '../tableauClient.js';
import type {
  TableauDatasource,
  TableauProject,
  TableauSite,
  TableauView,
  TableauWorkbook,
} from '../types.js';

const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

interface Pagination {
  pageNumber?: string | number;
  pageSize?: string | number;
  totalAvailable?: string | number;
}

/** Generic paged GET over a Tableau list endpoint. */
async function pagedGet<TRaw>(
  client: TableauClient,
  path: string,
  extract: (body: any) => { items: TRaw[]; pagination?: Pagination },
): Promise<TRaw[]> {
  const out: TRaw[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await client.get<any>(`${path}${sep}pageSize=${PAGE_SIZE}&pageNumber=${page}`);
    const { items, pagination } = extract(body);
    out.push(...items);
    const total = Number(pagination?.totalAvailable ?? out.length);
    if (out.length >= total || items.length === 0) break;
  }
  return out;
}

/** The current site (from server info + the signed-in session). */
export async function getCurrentSite(client: TableauClient, siteId: string, siteContentUrl: string): Promise<TableauSite> {
  const body = await client.get<any>(`/sites/${siteId}`);
  const site = body?.site;
  return {
    id: site?.id ?? siteId,
    name: site?.name ?? site?.contentUrl ?? siteContentUrl,
    contentUrl: site?.contentUrl ?? siteContentUrl,
  };
}

export async function getProjects(client: TableauClient, siteId: string): Promise<TableauProject[]> {
  const raw = await pagedGet<any>(client, `/sites/${siteId}/projects`, (b) => ({
    items: toArray(b?.projects?.project),
    pagination: b?.pagination,
  }));
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    parentProjectId: p.parentProjectId,
  }));
}

export async function getWorkbooks(client: TableauClient, siteId: string): Promise<TableauWorkbook[]> {
  const raw = await pagedGet<any>(client, `/sites/${siteId}/workbooks`, (b) => ({
    items: toArray(b?.workbooks?.workbook),
    pagination: b?.pagination,
  }));
  return raw.map((w) => ({
    id: w.id,
    name: w.name,
    contentUrl: w.contentUrl,
    webpageUrl: w.webpageUrl,
    projectId: w.project?.id,
    projectName: w.project?.name,
    ownerId: w.owner?.id,
    updatedAt: w.updatedAt,
  }));
}

export async function getViews(client: TableauClient, siteId: string): Promise<TableauView[]> {
  const raw = await pagedGet<any>(client, `/sites/${siteId}/views`, (b) => ({
    items: toArray(b?.views?.view),
    pagination: b?.pagination,
  }));
  return raw.map((v) => ({
    id: v.id,
    name: v.name,
    contentUrl: v.contentUrl,
    workbookId: v.workbook?.id,
    viewUrlName: v.viewUrlName,
  }));
}

export async function getPublishedDatasources(client: TableauClient, siteId: string): Promise<TableauDatasource[]> {
  const raw = await pagedGet<any>(client, `/sites/${siteId}/datasources`, (b) => ({
    items: toArray(b?.datasources?.datasource),
    pagination: b?.pagination,
  }));
  return raw.map((d) => ({
    id: d.id,
    name: d.name,
    contentUrl: d.contentUrl,
    projectId: d.project?.id,
    projectName: d.project?.name,
    type: d.type,
    isCertified: d.isCertified === 'true' || d.isCertified === true,
    updatedAt: d.updatedAt,
  }));
}

/** Views for a specific workbook (used during verification). */
export async function getWorkbookViews(client: TableauClient, siteId: string, workbookId: string): Promise<TableauView[]> {
  const body = await client.get<any>(`/sites/${siteId}/workbooks/${workbookId}/views?includeUsageStatistics=false`);
  return toArray<any>(body?.views?.view).map((v) => ({
    id: v.id,
    name: v.name,
    contentUrl: v.contentUrl,
    workbookId,
    viewUrlName: v.viewUrlName,
  }));
}
