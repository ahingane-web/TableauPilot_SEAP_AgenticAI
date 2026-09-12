/**
 * Datasource publishing (REST).
 *
 * Publishes a generated `.tds` (live Salesforce connection) to a specific project
 * via a single multipart request. The caller (TableauService) owns the target
 * project + datasource identity; this module performs the upload and returns what
 * Tableau actually created.
 *
 * Security: connection credentials (username/password) may be embedded in the
 * request payload so Tableau Cloud can connect. The payload is NEVER logged.
 */
import { escapeXml } from '../authoring/xml.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { TableauClient } from '../tableauClient.js';

const log = logger.child('publishing:datasource');

export interface PublishDatasourceConnectionCredentials {
  /** Connection username (non-secret). */
  name?: string;
  /** Connection password (SECRET — embedded into the request payload only). */
  password?: string;
  /** Embed the credentials with the datasource so it can refresh/connect unattended. */
  embed?: boolean;
  /** Use a Salesforce OAuth saved credential instead of name/password. */
  oAuth?: boolean;
}

export interface PublishDatasourceInput {
  siteId: string;
  projectId: string;
  datasourceName: string;
  /** The `.tds` XML to publish (live datasource). Provide this OR {@link tdsxBuffer}. */
  tdsXml?: string;
  /** A packaged `.tdsx` (zip of `.tds` + `.hyper`) to publish an extract datasource. */
  tdsxBuffer?: Buffer;
  overwrite?: boolean;
  connectionCredentials?: PublishDatasourceConnectionCredentials;
}

export interface PublishedDatasource {
  id: string;
  name: string;
  contentUrl?: string;
  projectId?: string;
  projectName?: string;
}

function credentialsXml(cc?: PublishDatasourceConnectionCredentials): string {
  if (!cc) return '';
  if (cc.oAuth) {
    // For an OAuth connection, `name` is the OAuth account username whose saved
    // credential Tableau should embed; no password is sent.
    const nameAttr = cc.name != null ? `name='${escapeXml(cc.name)}' ` : '';
    return `<connectionCredentials ${nameAttr}oAuth='true' embed='${cc.embed ? 'true' : 'false'}' />`;
  }
  if (cc.name != null) {
    return (
      `<connectionCredentials name='${escapeXml(cc.name)}' password='${escapeXml(cc.password ?? '')}' ` +
      `embed='${cc.embed ? 'true' : 'false'}' />`
    );
  }
  return '';
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, '_').slice(0, 120) || 'datasource';
}

/**
 * Publish a `.tds` to the given project. Returns the created datasource
 * (id/name/contentUrl) so the caller can lock it as the session source of truth.
 */
export async function publishDatasource(
  client: TableauClient,
  input: PublishDatasourceInput,
): Promise<PublishedDatasource> {
  // NOTE: request payload may embed a connection password; do NOT log it.
  const requestPayload =
    `<tsRequest>` +
    `<datasource name='${escapeXml(input.datasourceName)}'>` +
    credentialsXml(input.connectionCredentials) +
    `<project id='${escapeXml(input.projectId)}' />` +
    `</datasource>` +
    `</tsRequest>`;

  // Publish either a packaged `.tdsx` (extract) or a plain `.tds` (live).
  const base = sanitizeFilename(input.datasourceName);
  let filePart: { filename: string; body: Buffer | string };
  if (input.tdsxBuffer) {
    filePart = { filename: `${base}.tdsx`, body: input.tdsxBuffer };
  } else if (input.tdsXml != null) {
    filePart = { filename: `${base}.tds`, body: input.tdsXml };
  } else {
    throw new AppError('VALIDATION', 'publishDatasource requires either tdsXml or tdsxBuffer.');
  }

  log.info('Publishing Salesforce datasource', {
    datasourceName: input.datasourceName,
    projectId: input.projectId,
    overwrite: Boolean(input.overwrite),
    kind: input.tdsxBuffer ? 'tdsx' : 'tds',
    bytes: typeof filePart.body === 'string' ? Buffer.byteLength(filePart.body, 'utf8') : filePart.body.length,
  });

  const body = await client.postMultipart<any>(
    `/sites/${input.siteId}/datasources?overwrite=${input.overwrite ? 'true' : 'false'}`,
    [
      { name: 'request_payload', contentType: 'text/xml', body: requestPayload },
      {
        name: 'tableau_datasource',
        filename: filePart.filename,
        contentType: 'application/octet-stream',
        body: filePart.body,
      },
    ],
  );

  const ds = body?.datasource;
  if (!ds?.id) {
    throw new AppError('TABLEAU_API', 'Publish did not return a datasource id.');
  }
  log.info('Datasource published', { datasourceId: ds.id, project: ds.project?.name });
  return {
    id: ds.id,
    name: ds.name ?? input.datasourceName,
    contentUrl: ds.contentUrl,
    projectId: ds.project?.id ?? input.projectId,
    projectName: ds.project?.name,
  };
}
