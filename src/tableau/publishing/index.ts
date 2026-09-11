/**
 * Workbook publishing (REST).
 *
 * Publishes a generated .twb to a specific project via a single multipart request.
 * The caller (TableauService) enforces the target-project guard BEFORE this runs;
 * this module simply performs the upload and returns what Tableau actually created.
 */
import { escapeXml } from '../authoring/twbGenerator.js';
import { packageTwbx } from '../authoring/twbxPackager.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { TableauClient } from '../tableauClient.js';
import type { PublishResult } from '../types.js';

const log = logger.child('publishing');

export interface PublishWorkbookInput {
  siteId: string;
  projectId: string;
  workbookName: string;
  twbXml: string;
  overwrite: boolean;
  showTabs: boolean;
}

export async function publishWorkbook(client: TableauClient, input: PublishWorkbookInput): Promise<PublishResult> {
  const requestPayload =
    `<tsRequest>` +
    `<workbook name='${escapeXml(input.workbookName)}' showTabs='${input.showTabs ? 'true' : 'false'}'>` +
    `<project id='${escapeXml(input.projectId)}' />` +
    `</workbook>` +
    `</tsRequest>`;

  // Package the .twb into a .twbx (ZIP). This is the standard publish format and
  // avoids ambiguity in how Tableau's loader resolves the workbook file.
  const twbx = packageTwbx(input.twbXml, input.workbookName);
  log.info('Packaged workbook as .twbx', {
    workbookName: input.workbookName,
    twbxBytes: twbx.byteLength,
  });

  // skipConnectionCheck=true: do NOT run the server-side "publish check" that tries
  // to load/validate the workbook's connection to the published datasource at publish
  // time. That check is what was failing (400 "<publish check>" / 403 500000 internal
  // error). With it skipped, Tableau stores the workbook and validates the connection
  // when the workbook is actually opened. (workbookType is not a real Publish Workbook
  // parameter — the file type is inferred from the .twbx filename.)
  const body = await client.postMultipart<any>(
    `/sites/${input.siteId}/workbooks?overwrite=${input.overwrite ? 'true' : 'false'}&skipConnectionCheck=true`,
    [
      { name: 'request_payload', contentType: 'text/xml', body: requestPayload },
      {
        name: 'tableau_workbook',
        filename: `${sanitizeFilename(input.workbookName)}.twbx`,
        contentType: 'application/octet-stream',
        body: twbx,
      },
    ],
  );

  const wb = body?.workbook;
  if (!wb?.id) {
    throw new AppError('TABLEAU_API', 'Publish did not return a workbook id.');
  }
  log.info('Workbook published', { workbookId: wb.id, project: wb.project?.name });
  return {
    workbookId: wb.id,
    name: wb.name ?? input.workbookName,
    contentUrl: wb.contentUrl,
    webpageUrl: wb.webpageUrl,
    projectId: wb.project?.id ?? input.projectId,
    projectName: wb.project?.name,
  };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 120) || 'workbook';
}
