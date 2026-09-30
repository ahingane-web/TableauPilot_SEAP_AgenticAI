/**
 * Deterministic Tableau datasource (`.tds`) generator for the Salesforce Data Cloud
 * (Genie / `salesforce-genie`) connector.
 *
 * Reconciled 1:1 against `reference/DataCloudLiveDS.tds` and
 * `reference/DataCloudExtractDS.tds`. Do not reuse `generateSalesforceTds` — that is
 * CRM `class='salesforce'`, `[Account]` relations, and a different object-id shape.
 *
 * Live vs extract:
 *   - `live`   : no `<extract>`; manifest omits `ObjectModelExtractV2`; object-graph
 *                only `context=''`. Tableau queries Data Cloud over OAuth.
 *   - `extract`: `<extract class='hyper'>` over `Extract."<objectId>"` +
 *                `ObjectModelExtractV2` + `VConnDownstreamExtractsWithWarnings` +
 *                `context='extract'`.
 *
 * Column rule: REAL field API names (`ssot__Id__c`) as `remote-name`/`remote-alias`;
 * globally unique `local-name` (collisions become `ssot__Id__c (Account Contact)`).
 * Relation `name` is the friendly caption; `table` is `[public].[apiName]`.
 *
 * Salesforce, Excel, and BigQuery generators are untouched by this module.
 */
import { createHash } from 'node:crypto';
import { escapeXml } from './xml.js';
import type { SalesforceCardinality, SalesforceJoinType } from './tdsGenerator.js';
import { dataCloudToTwbType, dataCloudToHyperType } from '../../datacloud/client.js';

/** Stable internal named-connection id for generated Data Cloud datasources. */
export const DC_CONNECTION_NAME = 'salesforce-genie.tableaupilot';

export type DataCloudMaterialization = 'live' | 'extract';

export interface DataCloudColumnSpec {
  /** Real field API name (`ssot__Id__c`). */
  name: string;
  /** Data Cloud type token (STRING, NUMBER, DATE, DATETIME, BOOLEAN, …). */
  dcType: string;
  nillable?: boolean;
}

export interface DataCloudTableSpec {
  /** Physical/API name, e.g. `ssot__Account__dlm`. */
  object: string;
  /** Friendly caption, e.g. `Account` (relation name + object-graph caption). */
  caption: string;
  columns: DataCloudColumnSpec[];
}

export interface DataCloudConnectionInfo {
  /** Salesforce org login origin, e.g. `https://org.my.salesforce.com` (`instanceurl`). */
  instanceUrl: string;
  /** Data Cloud query host, e.g. `xxx.c360a.salesforce.com` (`server`). */
  server: string;
  /** Salesforce username (`username` — saved-credential match). */
  username: string;
  /** Data space name (`warehouse` + `dbname` suffix). */
  dataSpace: string;
  /** `dbname` = `a360/{pod}/{tenantId};{dataSpace}`. */
  tenantId: string;
  pod: string;
}

export interface DataCloudRelationshipSpec {
  leftObject: string;
  leftField: string;
  rightObject: string;
  rightField: string;
  cardinality?: SalesforceCardinality;
  joinType?: SalesforceJoinType;
}

export interface DataCloudTdsInput {
  datasourceName: string;
  connection: DataCloudConnectionInfo;
  materialization: DataCloudMaterialization;
  object: string;
  caption: string;
  columns: DataCloudColumnSpec[];
  extract?: { hyperDbname: string };
}

export interface DataCloudRelationshipsTdsInput {
  datasourceName: string;
  connection: DataCloudConnectionInfo;
  materialization: DataCloudMaterialization;
  tables: DataCloudTableSpec[];
  relationships: DataCloudRelationshipSpec[];
  extract?: { hyperDbname: string };
}

type TwbType = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

export { dataCloudToHyperType };

/**
 * Object-graph / Hyper table id `{caption}_{MD5(apiName)}` matching the reference
 * (`Account Contact_F53CF1…`). Spaces in the caption are kept.
 */
export function dataCloudObjectId(caption: string, apiName?: string): string {
  const cap = String(caption ?? '').trim() || String(apiName ?? '').trim() || 'Object';
  const hash = createHash('md5')
    .update(String(apiName ?? cap))
    .digest('hex')
    .toUpperCase();
  return `${cap}_${hash}`;
}

function localTypeToRemoteCode(twb: TwbType): number {
  switch (twb) {
    case 'boolean':
      return 11;
    case 'integer':
      return 20;
    case 'real':
      return 5;
    case 'date':
      return 133;
    case 'datetime':
      return 135;
    default:
      return 130;
  }
}

function aggregationFor(twb: TwbType): string {
  if (twb === 'integer' || twb === 'real') return 'Sum';
  if (twb === 'date' || twb === 'datetime') return 'Year';
  return 'Count';
}

interface NormField {
  real: string;
  local: string;
  twb: TwbType;
  dcType: string;
  nillable: boolean;
}

interface NormTable {
  object: string;
  caption: string;
  objectId: string;
  fields: NormField[];
}

function normalize(tables: DataCloudTableSpec[]): NormTable[] {
  const usedLocals = new Set<string>();
  return tables.map((t) => {
    const caption = String(t.caption ?? t.object ?? '').trim() || t.object;
    const objectId = dataCloudObjectId(caption, t.object);
    const fields = (t.columns ?? []).map((c) => {
      const real = String(c.name ?? '');
      let local = real;
      if (usedLocals.has(local)) {
        local = `${real} (${caption})`;
        let n = 2;
        while (usedLocals.has(local)) local = `${real} (${caption}) ${n++}`;
      }
      usedLocals.add(local);
      const twb = dataCloudToTwbType(c.dcType) as TwbType;
      return { real, local, twb, dcType: c.dcType, nillable: c.nillable !== false };
    });
    return { object: t.object, caption, objectId, fields };
  });
}

function localOf(norm: NormTable[], object: string, field: string): string {
  const t = norm.find((x) => x.object === object);
  const f = t?.fields.find((x) => x.real === field);
  return f?.local ?? field;
}

function instanceHost(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

function dbname(conn: DataCloudConnectionInfo): string {
  return `a360/${conn.pod}/${conn.tenantId};${conn.dataSpace}`;
}

function namedConnectionXml(conn: DataCloudConnectionInfo): string {
  const caption = escapeXml(instanceHost(conn.instanceUrl));
  const instanceurl = escapeXml(conn.instanceUrl.replace(/\/+$/, ''));
  const server = escapeXml(conn.server.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  return (
    `    <named-connections>\n` +
    `      <named-connection caption='${caption}' name='${DC_CONNECTION_NAME}'>\n` +
    `        <connection authentication='oauth' class='salesforce-genie' dbname='${escapeXml(dbname(conn))}' ` +
    `instanceurl='${instanceurl}' server='${server}' server-oauth='' sslmode='' ` +
    `username='${escapeXml(conn.username)}' warehouse='${escapeXml(conn.dataSpace)}' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n`
  );
}

function liveRelationXml(t: NormTable, indent: string): string {
  const cap = escapeXml(t.caption);
  const api = escapeXml(t.object);
  return `${indent}<relation connection='${DC_CONNECTION_NAME}' name='${cap}' table='[public].[${api}]' type='table' />\n`;
}

function liveRelationCollectionXml(tables: NormTable[], indent = '    '): string {
  const inner = indent + '  ';
  return `${indent}<relation type='collection'>\n` + tables.map((t) => liveRelationXml(t, inner)).join('') + `${indent}</relation>\n`;
}

function colsXml(tables: NormTable[], indent = '    '): string {
  const inner = indent + '  ';
  const maps: string[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      maps.push(`${inner}<map key='[${escapeXml(f.local)}]' value='[${escapeXml(t.caption)}].[${escapeXml(f.real)}]' />\n`);
    }
  }
  if (maps.length === 0) return '';
  return `${indent}<cols>\n` + maps.join('') + `${indent}</cols>\n`;
}

function metadataRecordXml(f: NormField, parentName: string, indent: string): string {
  const inner = indent + '  ';
  const remote = escapeXml(f.real);
  const containsNull = f.nillable ? 'true' : 'false';
  const cast = f.twb === 'real' ? `${inner}<cast-to-local-type>true</cast-to-local-type>\n` : '';
  return (
    `${indent}<metadata-record class='column'>\n` +
    `${inner}<remote-name>${remote}</remote-name>\n` +
    `${inner}<remote-type>${localTypeToRemoteCode(f.twb)}</remote-type>\n` +
    `${inner}<local-name>[${escapeXml(f.local)}]</local-name>\n` +
    `${inner}<parent-name>[${escapeXml(parentName)}]</parent-name>\n` +
    `${inner}<remote-alias>${remote}</remote-alias>\n` +
    `${inner}<local-type>${f.twb}</local-type>\n` +
    `${inner}<aggregation>${aggregationFor(f.twb)}</aggregation>\n` +
    `${inner}<contains-null>${containsNull}</contains-null>\n` +
    cast +
    `${indent}</metadata-record>\n`
  );
}

function metadataRecordsXml(tables: NormTable[], indent = '    '): string {
  const inner = indent + '  ';
  const blocks = tables.map((t) => t.fields.map((f) => metadataRecordXml(f, t.caption, inner)).join('')).join('');
  if (!blocks) return '';
  return `${indent}<metadata-records>\n` + blocks + `${indent}</metadata-records>\n`;
}

function columnsXml(tables: NormTable[]): string {
  let out = '';
  for (const t of tables) {
    for (const f of t.fields) {
      const role = f.twb === 'integer' || f.twb === 'real' ? 'measure' : 'dimension';
      const type = role === 'measure' ? 'quantitative' : f.twb === 'date' || f.twb === 'datetime' ? 'ordinal' : 'nominal';
      out += `  <column datatype='${f.twb}' name='[${escapeXml(f.local)}]' role='${role}' type='${type}' />\n`;
    }
  }
  return out;
}

function extractRelationCollectionXml(tables: NormTable[], indent = '      '): string {
  const inner = indent + '  ';
  const rels = tables
    .map((t) => `${inner}<relation name='${escapeXml(t.objectId)}' table='[Extract].[${escapeXml(t.objectId)}]' type='table' />\n`)
    .join('');
  return `${indent}<relation type='collection'>\n` + rels + `${indent}</relation>\n`;
}

function extractColsXml(tables: NormTable[], indent = '      '): string {
  const inner = indent + '  ';
  const maps: string[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      maps.push(`${inner}<map key='[${escapeXml(f.local)}]' value='[${escapeXml(t.objectId)}].[${escapeXml(f.real)}]' />\n`);
    }
  }
  if (maps.length === 0) return '';
  return `${indent}<cols>\n` + maps.join('') + `${indent}</cols>\n`;
}

function extractMetadataRecordsXml(tables: NormTable[], indent = '      '): string {
  const inner = indent + '  ';
  const blocks = tables.map((t) => t.fields.map((f) => metadataRecordXml(f, t.objectId, inner)).join('')).join('');
  if (!blocks) return '';
  return `${indent}<metadata-records>\n` + blocks + `${indent}</metadata-records>\n`;
}

function extractElementXml(tables: NormTable[], hyperDbname: string, relationXml: string): string {
  return (
    `  <extract count='-1' enabled='true' object-id='' units='records' user-specific='false'>\n` +
    `    <connection authentication='auth-none' class='hyper' dbname='${escapeXml(hyperDbname)}' ` +
    `default-settings='yes' schema='Extract' tablename='Extract'>\n` +
    relationXml +
    extractColsXml(tables) +
    extractMetadataRecordsXml(tables) +
    `    </connection>\n` +
    `  </extract>\n`
  );
}

function joinTreeXml(
  tables: NormTable[],
  relationships: DataCloudRelationshipSpec[],
  opts: { live: boolean },
  indent = '    ',
): string {
  const relByRight = new Map(relationships.map((r) => [r.rightObject, r]));
  const leaf = (t: NormTable, ind: string): string =>
    opts.live
      ? liveRelationXml(t, ind)
      : `${ind}<relation name='${escapeXml(t.objectId)}' table='[Extract].[${escapeXml(t.objectId)}]' type='table' />\n`;

  const buildNode = (k: number, ind: string): string => {
    const t = tables[k]!;
    if (k === 0) return leaf(t, ind);
    const rel = relByRight.get(t.object);
    const joinType: SalesforceJoinType = rel?.joinType ?? 'left';
    const inner = ind + '  ';
    return (
      `${ind}<relation join='${joinType}' type='join'>\n` +
      buildNode(k - 1, inner) +
      leaf(t, inner) +
      joinClauseXml(rel, tables, opts.live, inner) +
      `${ind}</relation>\n`
    );
  };
  return buildNode(tables.length - 1, indent);
}

function joinClauseXml(
  rel: DataCloudRelationshipSpec | undefined,
  tables: NormTable[],
  live: boolean,
  indent: string,
): string {
  const inner = indent + '  ';
  const innerer = inner + '  ';
  const parent = (object: string): string => {
    const t = tables.find((x) => x.object === object);
    if (live) return t?.caption ?? object;
    return t?.objectId ?? object;
  };
  const left = rel ? `[${escapeXml(parent(rel.leftObject))}].[${escapeXml(rel.leftField)}]` : '';
  const right = rel ? `[${escapeXml(parent(rel.rightObject))}].[${escapeXml(rel.rightField)}]` : '';
  return (
    `${indent}<clause type='join'>\n` +
    `${inner}<expression op='='>\n` +
    `${innerer}<expression op='${left}' />\n` +
    `${innerer}<expression op='${right}' />\n` +
    `${inner}</expression>\n` +
    `${indent}</clause>\n`
  );
}

function objectGraphXml(
  tables: NormTable[],
  relationships: DataCloudRelationshipSpec[],
  materialization: DataCloudMaterialization,
): string {
  const objectsXml = tables
    .map((t) => {
      const cap = escapeXml(t.caption);
      const oid = escapeXml(t.objectId);
      const api = escapeXml(t.object);
      const extractProps =
        materialization === 'extract'
          ? `        <properties context='extract'>\n` +
            `          <relation name='${oid}' table='[Extract].[${oid}]' type='table' />\n` +
            `        </properties>\n`
          : '';
      return (
        `      <object caption='${cap}' id='${oid}'>\n` +
        `        <properties context=''>\n` +
        `          <relation connection='${DC_CONNECTION_NAME}' name='${cap}' table='[public].[${api}]' type='table' />\n` +
        `        </properties>\n` +
        extractProps +
        `      </object>\n`
      );
    })
    .join('');

  const relsXml = relationships
    .map((r) => {
      const card: SalesforceCardinality = r.cardinality ?? 'many-to-many';
      const leftUnique = card === 'one-to-many' || card === 'one-to-one';
      const rightUnique = card === 'many-to-one' || card === 'one-to-one';
      const leftLocal = escapeXml(localOf(tables, r.leftObject, r.leftField));
      const rightLocal = escapeXml(localOf(tables, r.rightObject, r.rightField));
      const leftT = tables.find((t) => t.object === r.leftObject);
      const rightT = tables.find((t) => t.object === r.rightObject);
      const leftId = escapeXml(leftT?.objectId ?? dataCloudObjectId(r.leftObject, r.leftObject));
      const rightId = escapeXml(rightT?.objectId ?? dataCloudObjectId(r.rightObject, r.rightObject));
      const head = (u: boolean) => (u ? `is-db-set-unique-key='true' ` : '');
      const tail = (u: boolean) => (u ? ` unique-key='true'` : '');
      return (
        `      <relationship>\n` +
        `        <expression op='='>\n` +
        `          <expression op='[${leftLocal}]' />\n` +
        `          <expression op='[${rightLocal}]' />\n` +
        `        </expression>\n` +
        `        <first-end-point ${head(leftUnique)}object-id='${leftId}'${tail(leftUnique)} />\n` +
        `        <second-end-point ${head(rightUnique)}object-id='${rightId}'${tail(rightUnique)} />\n` +
        `      </relationship>\n`
      );
    })
    .join('');

  return (
    `  <object-graph>\n` +
    `    <objects>\n` +
    objectsXml +
    `    </objects>\n` +
    `    <relationships>\n` +
    relsXml +
    `    </relationships>\n` +
    `  </object-graph>\n`
  );
}

function manifestXml(materialization: DataCloudMaterialization, relationshipPerf: boolean): string {
  const perf = relationshipPerf ? `    <ObjectModelRelationshipPerfOptions />\n` : '';
  const extractV2 = materialization === 'extract' ? `    <ObjectModelExtractV2 />\n` : '';
  const downstream =
    materialization === 'extract' ? `    <VConnDownstreamExtractsWithWarnings />\n` : '';
  return (
    `  <document-format-change-manifest>\n` +
    `    <ObjectModelEncapsulateLegacy />\n` +
    extractV2 +
    perf +
    `    <ObjectModelTableType />\n` +
    `    <SchemaViewerObjectModel />\n` +
    downstream +
    `  </document-format-change-manifest>\n`
  );
}

function header(datasourceName: string): string {
  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${escapeXml(datasourceName)}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n`
  );
}

function assertExtract(materialization: DataCloudMaterialization, extract: { hyperDbname: string } | undefined): void {
  if (materialization === 'extract' && !extract?.hyperDbname) {
    throw new Error('Data Cloud extract generation requires an extract.hyperDbname.');
  }
}

export type DataCloudTwbType = TwbType;

export interface DataCloudFieldIdentity {
  object: string;
  caption: string;
  real: string;
  local: string;
  twb: DataCloudTwbType;
}

export function dataCloudFieldIdentities(tables: DataCloudTableSpec[]): DataCloudFieldIdentity[] {
  return normalize(tables).flatMap((t) =>
    t.fields.map((f) => ({ object: t.object, caption: t.caption, real: f.real, local: f.local, twb: f.twb })),
  );
}

export function generateDataCloudTds(input: DataCloudTdsInput): string {
  const object = String(input.object ?? '').trim();
  if (!object) throw new Error('generateDataCloudTds requires an object.');
  assertExtract(input.materialization, input.extract);
  const caption = String(input.caption ?? object).trim() || object;
  const norm = normalize([{ object, caption, columns: input.columns ?? [] }]);
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || caption;

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, extractRelationCollectionXml(norm))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, false) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(input.connection) +
    liveRelationXml(norm[0]!, '    ') +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    objectGraphXml(norm, [], input.materialization) +
    `</datasource>\n`
  );
}

export function generateDataCloudRelationshipsTds(input: DataCloudRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) throw new Error('generateDataCloudRelationshipsTds requires at least two tables.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(tables);
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || tables[0]?.caption || tables[0]?.object || '';

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, extractRelationCollectionXml(norm))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, true) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(input.connection) +
    liveRelationCollectionXml(norm) +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    objectGraphXml(norm, input.relationships ?? [], input.materialization) +
    `</datasource>\n`
  );
}

export function generateDataCloudPhysicalJoinTds(input: DataCloudRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) throw new Error('generateDataCloudPhysicalJoinTds requires at least two tables.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(tables);
  const relationships = input.relationships ?? [];
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || tables[0]?.caption || tables[0]?.object || '';

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, joinTreeXml(norm, relationships, { live: false }, '      '))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, false) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(input.connection) +
    joinTreeXml(norm, relationships, { live: true }) +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    `</datasource>\n`
  );
}
