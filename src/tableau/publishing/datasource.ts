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

/** A connection belonging to a published datasource (from List Data Source Connections). */
export interface DatasourceConnection {
  id: string;
  type?: string;
  serverAddress?: string;
  userName?: string;
}

/**
 * List the connections of a published datasource. A Salesforce extract datasource has one
 * live Salesforce connection (plus the internal hyper/extract connection); callers use the
 * returned `id`(s) to embed credentials via {@link embedDatasourceConnectionCredential}.
 */
export async function listDatasourceConnections(
  client: TableauClient,
  siteId: string,
  datasourceId: string,
): Promise<DatasourceConnection[]> {
  const body = await client.get<any>(`/sites/${siteId}/datasources/${datasourceId}/connections`);
  const raw = body?.connections?.connection;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr.map((c: any) => ({
    id: String(c?.id ?? ''),
    type: c?.type,
    serverAddress: c?.serverAddress,
    userName: c?.userName,
  })).filter((c: DatasourceConnection) => c.id);
}

/**
 * Update a published datasource connection to EMBED its credential ("Update Data Source
 * Connection"). For an OAuth (Salesforce) connection this embeds the requesting user's SAVED
 * OAuth credential (matched by `userName`) so the datasource can refresh unattended. For
 * OAuth there is no raw password to send — only `embedPassword='true'` (+ the account
 * `userName`) is used; Tableau resolves the saved credential server-side.
 */
export async function embedDatasourceConnectionCredential(
  client: TableauClient,
  siteId: string,
  datasourceId: string,
  connectionId: string,
  opts: { userName?: string } = {},
): Promise<void> {
  const connection: Record<string, unknown> = { embedPassword: 'true' };
  if (opts.userName) connection.userName = opts.userName;
  await client.putJson(`/sites/${siteId}/datasources/${datasourceId}/connections/${connectionId}`, { connection });
  log.info('Embedded saved credential on datasource connection', { datasourceId, connectionId });
}

/**
 * Trigger a full extract refresh for a published datasource ("Update Data Source Now").
 * Re-queries the live source (via the datasource's embedded/saved credential) and rebuilds
 * the server-side extract, so the datasource reflects fresh data right after publishing.
 * Returns the async job id Tableau created. Requires the datasource to have connectable
 * credentials (embedded on publish) or the job will fail server-side.
 */
export async function refreshDatasourceNow(
  client: TableauClient,
  siteId: string,
  datasourceId: string,
): Promise<{ jobId?: string }> {
  // The endpoint accepts an empty request body; Tableau returns the created job.
  const body = await client.postJson<any>(`/sites/${siteId}/datasources/${datasourceId}/refresh`, {});
  const jobId: string | undefined = body?.job?.id;
  log.info('Started datasource extract refresh', { datasourceId, jobId });
  return { jobId };
}
