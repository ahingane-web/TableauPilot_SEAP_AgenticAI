/**
 * Embed URL helpers.
 *
 * We do NOT fabricate a Tableau viewer — we build the URL the Embedding API v3
 * `<tableau-viz>` loads (an iframe hosting the real published dashboard on the
 * customer's pod), READ-ONLY. Web Authoring (editing) has been removed: users only
 * VIEW the published dashboard.
 */
import type { TableauView, TableauWorkbook } from '../types.js';

export { generateTwb, escapeXml } from './twbGenerator.js';

/**
 * Build the READ-ONLY view URL for a published workbook/view, with the classic
 * `:embed=yes&:tabs=yes&:toolbar=no` params so the embed shows the dashboard with its
 * sheet TABS but no toolbar/editing. Prefers a real view content URL; falls back to the
 * workbook's webpageUrl (returned by Tableau, never guessed).
 */
export function buildViewUrl(params: {
  serverUrl: string;
  siteContentUrl: string;
  view?: TableauView;
  workbook?: TableauWorkbook;
}): string | undefined {
  const { serverUrl, siteContentUrl, view, workbook } = params;
  const base = serverUrl.replace(/\/+$/, '');
  const embedParams = ':embed=yes&:toolbar=no';
  // Build the interactive, hash-routed view URL for VIEW-ONLY display:
  //   https://<pod>/#/site/<site>/views/<Workbook>/<Sheet>?:embed=yes&:toolbar=no
  // (e.g. .../#/site/ahingane-2010f153ff/views/test7/SalesAnalysis?:embed=yes&:toolbar=no)
  const viewPath = resolveViewPath(view, workbook);
  if (!viewPath) return undefined;
  return `${base}/#/site/${encodeURIComponent(siteContentUrl)}/views/${viewPath}?${embedParams}`;
}

/**
 * Resolve the `<Workbook>/<Sheet>` view path from a view's contentUrl (form
 * `Workbook/sheets/View`) or, failing that, from the workbook's `webpageUrl`.
 */
function resolveViewPath(view?: TableauView, workbook?: TableauWorkbook): string | undefined {
  if (view?.contentUrl) return view.contentUrl.replace(/\/sheets\//, '/');
  if (workbook?.webpageUrl) {
    const cleaned = workbook.webpageUrl.replace(/#\//, '/').replace(/[?#].*$/, '');
    const viewsIdx = cleaned.indexOf('/views/');
    if (viewsIdx >= 0) {
      const path = cleaned.slice(viewsIdx + '/views/'.length).replace(/\/sheets\//, '/');
      if (path) return path;
    }
  }
  return undefined;
}
