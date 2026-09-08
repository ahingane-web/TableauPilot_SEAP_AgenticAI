/**
 * Workbook publishing (REST).
 *
 * Publishes a generated .twb to a specific project via a single multipart request.
 * The caller (TableauService) enforces the target-project guard BEFORE this runs;
 * this module simply performs the upload and returns what Tableau actually created.
 */
import { escapeXml } from '../authoring/twbGenerator.js';
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

  const body = await client.postMultipart<any>(
    `/sites/${input.siteId}/workbooks?overwrite=${input.overwrite ? 'true' : 'false'}&workbookType=twb`,
    [
      { name: 'request_payload', contentType: 'text/xml', body: requestPayload },
      {
        name: 'tableau_workbook',
        filename: `${sanitizeFilename(input.workbookName)}.twb`,
        contentType: 'application/octet-stream',
        body: Buffer.from(input.twbXml, 'utf8'),
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
