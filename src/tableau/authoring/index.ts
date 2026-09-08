/**
 * Web Authoring helpers.
 *
 * Category B of the capability boundary: opening the REAL Tableau Cloud Web
 * Authoring experience. We do NOT fabricate a Tableau editor — we build the URL
 * that the Embedding API v3 `TableauAuthoringViz` loads (an iframe hosting the real
 * Tableau authoring UI on the customer's pod).
 */
import type { TableauView, TableauWorkbook } from '../types.js';

export { generateTwb, escapeXml } from './twbGenerator.js';

/**
 * Build the Web Authoring (edit) URL for an existing view/workbook.
 * Tableau's web-edit route is: {server}/#/site/{site}/views/{viewPath}?:mode=authoring
 * We prefer a real view content URL; if only the workbook is known we fall back to
 * its webpageUrl (returned by Tableau, never guessed).
 */
export function buildWebEditUrl(params: {
  serverUrl: string;
  siteContentUrl: string;
  view?: TableauView;
  workbook?: TableauWorkbook;
}): string | undefined {
  const { serverUrl, siteContentUrl, view, workbook } = params;
  const base = serverUrl.replace(/\/+$/, '');
  if (view?.contentUrl) {
    // contentUrl form: "Workbook/sheets/View" -> authoring path uses the same content url.
    const path = view.contentUrl.replace(/\/sheets\//, '/');
    return `${base}/#/site/${encodeURIComponent(siteContentUrl)}/views/${path}?:mode=authoring&:embed=y`;
  }
  if (workbook?.webpageUrl) {
    // Convert a workbook webpage URL into an authoring URL when possible.
    return `${workbook.webpageUrl}${workbook.webpageUrl.includes('?') ? '&' : '?'}:mode=authoring&:embed=y`;
  }
  return undefined;
}

/**
 * Build the "create new workbook against a published datasource" authoring URL.
 * This is the documented entry point for authoring a brand-new workbook connected
 * to a published datasource, loaded inside the embed.
 */
export function buildNewWorkbookAuthoringUrl(params: {
  serverUrl: string;
  siteContentUrl: string;
  datasourceContentUrl?: string;
  datasourceId: string;
}): string {
  const { serverUrl, siteContentUrl, datasourceContentUrl, datasourceId } = params;
  const base = serverUrl.replace(/\/+$/, '');
  const ds = datasourceContentUrl ?? datasourceId;
  return `${base}/#/site/${encodeURIComponent(siteContentUrl)}/authoringNewWorkbook/${encodeURIComponent(ds)}?:embed=y`;
}
