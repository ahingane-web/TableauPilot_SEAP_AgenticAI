/**
 * Deterministic Tableau datasource (`.tds`) generator for the Snowflake connector.
 *
 * Reconciled 1:1 against `reference/SnowflakeLiveDS.tds` and
 * `reference/SnowflakeExtractDS.tds`. Do not reuse `generateSalesforceTds` /
 * `generateBigQueryTds` / `generateDataCloudTds` — those use the wrong connection
 * class, relation shape, and object-id.
 *
 * Live vs extract:
 *   - `live`   : no `<extract>`; manifest omits `ObjectModelExtractV2`; object-graph
 *                only `context=''`. Tableau queries Snowflake with Username Password.
 *   - `extract`: `<extract class='hyper'>` over `Extract."<objectId>"` +
 *                `ObjectModelExtractV2` + `VConnDownstreamExtractsWithWarnings` +
 *                `context='extract'`. `<extract object-id>` is the first table's
 *                object-id; hyper `username` is empty.
 *
 * Column rule: REAL Snowflake names as `remote-name`/`remote-alias`; globally unique
 * `local-name` (collisions become `Name (TABLE)`). Relation `name` is the table;
 * `table` is `[DATABASE].[SCHEMA].[TABLE]`.
 *
 * Salesforce, Excel, BigQuery, and Data Cloud generators are untouched by this module.
 */
import { createHash } from 'node:crypto';
import { escapeXml } from './xml.js';
import type { SalesforceCardinality, SalesforceJoinType } from './tdsGenerator.js';
import { snowflakeToTwbType, snowflakeToHyperType } from '../../snowflake/client.js';

/** Stable internal named-connection id for generated Snowflake datasources. */
export const SNOWFLAKE_CONNECTION_NAME = 'snowflake.tableaupilot';

export type SnowflakeMaterialization = 'live' | 'extract';

export interface SnowflakeColumnSpec {
  name: string;
  sfType: string;
  nillable?: boolean;
}

export interface SnowflakeTableSpec {
  table: string;
  columns: SnowflakeColumnSpec[];
}

export interface SnowflakeConnectionInfo {
  /** Account host (`server` + named-connection caption). */
  server: string;
  /** Snowflake database (`dbname`). */
  database: string;
  /** Snowflake schema (`schema`). */
  schema: string;
  /** Compute warehouse (`warehouse`). */
  warehouse: string;
  /** Snowflake username (`username`). */
  username: string;
}

export interface SnowflakeRelationshipSpec {
  leftTable: string;
  leftField: string;
  rightTable: string;
  rightField: string;
  cardinality?: SalesforceCardinality;
  joinType?: SalesforceJoinType;
}

export interface SnowflakeTdsInput {
  datasourceName: string;
  connection: SnowflakeConnectionInfo;
  materialization: SnowflakeMaterialization;
  table: string;
  columns: SnowflakeColumnSpec[];
  extract?: { hyperDbname: string };
}

export interface SnowflakeRelationshipsTdsInput {
  datasourceName: string;
  connection: SnowflakeConnectionInfo;
  materialization: SnowflakeMaterialization;
  tables: SnowflakeTableSpec[];
  relationships: SnowflakeRelationshipSpec[];
  extract?: { hyperDbname: string };
}

type TwbType = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

export { snowflakeToHyperType };

/**
 * Object-graph / Hyper table id `{TABLE} ({DATABASE}.{TABLE})_{MD5(db.schema.table)}`
 * matching the reference (`ORDERS (TABLEAUAGENT.ORDERS)_DC63…`). Schema is omitted
 * from the caption.
 */
export function snowflakeObjectId(database: string, schema: string, table: string): string {
  const tbl = String(table ?? '').trim() || 'TABLE';
  const db = String(database ?? '').trim() || 'DB';
  const sch = String(schema ?? '').trim() || 'PUBLIC';
  const hash = createHash('md5').update(`${db}.${sch}.${tbl}`).digest('hex').toUpperCase();
  return `${tbl} (${db}.${tbl})_${hash}`;
}

function liveRemoteType(twb: TwbType): number {
  switch (twb) {
    case 'integer':
    case 'real':
      return 131;
    case 'date':
      return 7;
    case 'datetime':
      return 135;
    case 'boolean':
      return 11;
    default:
      return 129;
  }
}

function extractRemoteType(twb: TwbType): number {
  switch (twb) {
    case 'integer':
      return 20;
    case 'real':
      return 5;
    case 'date':
      return 133;
    case 'datetime':
      return 135;
    case 'boolean':
      return 11;
    default:
      return 129;
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
  sfType: string;
  nillable: boolean;
}

interface NormTable {
  table: string;
  objectId: string;
  fields: NormField[];
}

function normalize(database: string, schema: string, tables: SnowflakeTableSpec[]): NormTable[] {
  const usedLocals = new Set<string>();
  return tables.map((t) => {
    const table = String(t.table ?? '').trim();
    const objectId = snowflakeObjectId(database, schema, table);
    const fields = (t.columns ?? []).map((c) => {
      const real = String(c.name ?? '');
      let local = real;
      if (usedLocals.has(local)) {
        local = `${real} (${table})`;
        let n = 2;
        while (usedLocals.has(local)) local = `${real} (${table}) ${n++}`;
      }
      usedLocals.add(local);
      return {
        real,
        local,
        twb: snowflakeToTwbType(c.sfType) as TwbType,
        sfType: c.sfType,
        nillable: c.nillable !== false,
      };
    });
    return { table, objectId, fields };
  });
}

function localOf(norm: NormTable[], table: string, field: string): string {
  const t = norm.find((x) => x.table === table);
  const f = t?.fields.find((x) => x.real === field);
  return f?.local ?? field;
}

function namedConnectionXml(conn: SnowflakeConnectionInfo): string {
  const host = escapeXml(conn.server.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  const user = escapeXml(conn.username);
  return (
    `    <named-connections>\n` +
    `      <named-connection caption='${host}' name='${SNOWFLAKE_CONNECTION_NAME}'>\n` +
    `        <connection authentication='Username Password' class='snowflake' ` +
    `dbname='${escapeXml(conn.database)}' max-varchar-size='' odbc-connect-string-extras='' ` +
    `one-time-sql='' schema='${escapeXml(conn.schema)}' server='${host}' service='' ` +
    `temp-table-detection='optimized' username='${user}' warehouse='${escapeXml(conn.warehouse)}' ` +
    `workgroup-auth-mode='' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n`
  );
}

function liveRelationXml(t: NormTable, conn: SnowflakeConnectionInfo, indent: string): string {
  const name = escapeXml(t.table);
  const table = `[${escapeXml(conn.database)}].[${escapeXml(conn.schema)}].[${escapeXml(t.table)}]`;
  return `${indent}<relation connection='${SNOWFLAKE_CONNECTION_NAME}' name='${name}' table='${table}' type='table' />\n`;
}

function liveRelationCollectionXml(tables: NormTable[], conn: SnowflakeConnectionInfo, indent = '    '): string {
  const inner = indent + '  ';
  return (
    `${indent}<relation type='collection'>\n` +
    tables.map((t) => liveRelationXml(t, conn, inner)).join('') +
    `${indent}</relation>\n`
  );
}

function colsXml(tables: NormTable[], indent = '    '): string {
  const inner = indent + '  ';
  const maps: string[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      maps.push(
        `${inner}<map key='[${escapeXml(f.local)}]' value='[${escapeXml(t.table)}].[${escapeXml(f.real)}]' />\n`,
      );
    }
  }
  if (maps.length === 0) return '';
  return `${indent}<cols>\n` + maps.join('') + `${indent}</cols>\n`;
}

function debugAttrs(twb: TwbType, forExtract: boolean): string {
  if (forExtract) return '';
  if (twb === 'integer' || twb === 'real') {
    return (
      `        <attributes>\n` +
      `          <attribute datatype='string' name='DebugRemoteType'>&quot;SQL_DECIMAL&quot;</attribute>\n` +
      `          <attribute datatype='string' name='DebugWireType'>&quot;SQL_C_NUMERIC&quot;</attribute>\n` +
      `        </attributes>\n`
    );
  }
  if (twb === 'string') {
    return (
      `        <attributes>\n` +
      `          <attribute datatype='boolean' name='TypeIsVarchar'>true</attribute>\n` +
      `          <attribute datatype='string' name='DebugRemoteType'>&quot;SQL_VARCHAR&quot;</attribute>\n` +
      `        </attributes>\n`
    );
  }
  if (twb === 'date') {
    return (
      `        <attributes>\n` +
      `          <attribute datatype='string' name='DebugRemoteType'>&quot;SQL_TYPE_DATE&quot;</attribute>\n` +
      `        </attributes>\n`
    );
  }
  return '';
}

function metadataRecordXml(
  f: NormField,
  parentName: string,
  objectId: string,
  familyName: string,
  indent: string,
  forExtract: boolean,
): string {
  const inner = indent + '  ';
  const remote = escapeXml(f.real);
  const containsNull = f.nillable ? 'true' : 'false';
  const remoteType = forExtract ? extractRemoteType(f.twb) : liveRemoteType(f.twb);
  const width = !forExtract && f.twb === 'string' ? `${inner}<width>16777216</width>\n` : '';
  const collation = !forExtract && f.twb === 'string' ? `${inner}<collation flag='0' name='binary' />\n` : '';
  const precision =
    !forExtract && (f.twb === 'integer' || f.twb === 'real')
      ? `${inner}<precision>38</precision>\n${inner}<scale>${f.twb === 'integer' ? '0' : '2'}</scale>\n`
      : '';
  const family = forExtract ? `${inner}<family>${escapeXml(familyName)}</family>\n` : '';
  const parent = forExtract ? objectId : parentName;
  return (
    `${indent}<metadata-record class='column'>\n` +
    `${inner}<remote-name>${remote}</remote-name>\n` +
    `${inner}<remote-type>${remoteType}</remote-type>\n` +
    `${inner}<local-name>[${escapeXml(f.local)}]</local-name>\n` +
    `${inner}<parent-name>[${escapeXml(parent)}]</parent-name>\n` +
    `${inner}<remote-alias>${remote}</remote-alias>\n` +
    `${inner}<local-type>${f.twb}</local-type>\n` +
    `${inner}<aggregation>${aggregationFor(f.twb)}</aggregation>\n` +
    precision +
    width +
    `${inner}<contains-null>${containsNull}</contains-null>\n` +
    collation +
    debugAttrs(f.twb, forExtract) +
    family +
    `${inner}<object-id>[${escapeXml(objectId)}]</object-id>\n` +
    `${indent}</metadata-record>\n`
  );
}

function metadataRecordsXml(tables: NormTable[], indent = '    ', forExtract = false): string {
  const inner = indent + '  ';
  const blocks = tables
    .map((t) => t.fields.map((f) => metadataRecordXml(f, t.table, t.objectId, t.table, inner, forExtract)).join(''))
    .join('');
  if (!blocks) return '';
  return `${indent}<metadata-records>\n` + blocks + `${indent}</metadata-records>\n`;
}

function columnsXml(tables: NormTable[]): string {
  let out = '';
  for (const t of tables) {
    const oid = escapeXml(t.objectId);
    const cap = escapeXml(t.table);
    out += `  <column caption='${cap}' datatype='table' name='[__tableau_internal_object_id__].[${oid}]' role='measure' type='quantitative' />\n`;
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
    .map(
      (t) =>
        `${inner}<relation name='${escapeXml(t.objectId)}' table='[Extract].[${escapeXml(t.objectId)}]' type='table' />\n`,
    )
    .join('');
  return `${indent}<relation type='collection'>\n` + rels + `${indent}</relation>\n`;
}

function extractColsXml(tables: NormTable[], indent = '      '): string {
  const inner = indent + '  ';
  const maps: string[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      maps.push(
        `${inner}<map key='[${escapeXml(f.local)}]' value='[${escapeXml(t.objectId)}].[${escapeXml(f.real)}]' />\n`,
      );
    }
  }
  if (maps.length === 0) return '';
  return `${indent}<cols>\n` + maps.join('') + `${indent}</cols>\n`;
}

function extractElementXml(tables: NormTable[], hyperDbname: string, relationXml: string): string {
  const firstId = escapeXml(tables[0]?.objectId ?? '');
  return (
    `  <extract _.fcp.VConnDownstreamExtractsWithWarnings.true...user-specific='false' count='-1' enabled='true' object-id='${firstId}' units='records'>\n` +
    `    <connection authentication='auth-none' class='hyper' dbname='${escapeXml(hyperDbname)}' ` +
    `default-settings='yes' schema='Extract' sslmode='' tablename='Extract' username=''>\n` +
    relationXml +
    extractColsXml(tables) +
    metadataRecordsXml(tables, '      ', true) +
    `    </connection>\n` +
    `  </extract>\n`
  );
}

function joinTreeXml(
  tables: NormTable[],
  relationships: SnowflakeRelationshipSpec[],
  conn: SnowflakeConnectionInfo,
  opts: { live: boolean },
  indent = '    ',
): string {
  const relByRight = new Map(relationships.map((r) => [r.rightTable, r]));
  const leaf = (t: NormTable, ind: string): string =>
    opts.live
      ? liveRelationXml(t, conn, ind)
      : `${ind}<relation name='${escapeXml(t.objectId)}' table='[Extract].[${escapeXml(t.objectId)}]' type='table' />\n`;

  const buildNode = (k: number, ind: string): string => {
    const t = tables[k]!;
    if (k === 0) return leaf(t, ind);
    const rel = relByRight.get(t.table);
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
  rel: SnowflakeRelationshipSpec | undefined,
  tables: NormTable[],
  live: boolean,
  indent: string,
): string {
  const inner = indent + '  ';
  const innerer = inner + '  ';
  const parent = (table: string): string => {
    const t = tables.find((x) => x.table === table);
    if (live) return t?.table ?? table;
    return t?.objectId ?? table;
  };
  const left = rel ? `[${escapeXml(parent(rel.leftTable))}].[${escapeXml(rel.leftField)}]` : '';
  const right = rel ? `[${escapeXml(parent(rel.rightTable))}].[${escapeXml(rel.rightField)}]` : '';
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
  relationships: SnowflakeRelationshipSpec[],
  conn: SnowflakeConnectionInfo,
  materialization: SnowflakeMaterialization,
): string {
  const objectsXml = tables
    .map((t) => {
      const cap = escapeXml(t.table);
      const oid = escapeXml(t.objectId);
      const table = `[${escapeXml(conn.database)}].[${escapeXml(conn.schema)}].[${escapeXml(t.table)}]`;
      const extractProps =
        materialization === 'extract'
          ? `        <properties context='extract'>\n` +
            `          <relation name='${oid}' table='[Extract].[${oid}]' type='table' />\n` +
            `        </properties>\n`
          : '';
      return (
        `      <object caption='${cap}' id='${oid}'>\n` +
        `        <properties context=''>\n` +
        `          <relation connection='${SNOWFLAKE_CONNECTION_NAME}' name='${cap}' table='${table}' type='table' />\n` +
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
      const leftLocal = escapeXml(localOf(tables, r.leftTable, r.leftField));
      const rightLocal = escapeXml(localOf(tables, r.rightTable, r.rightField));
      const leftT = tables.find((t) => t.table === r.leftTable);
      const rightT = tables.find((t) => t.table === r.rightTable);
      const leftId = escapeXml(leftT?.objectId ?? snowflakeObjectId(conn.database, conn.schema, r.leftTable));
      const rightId = escapeXml(rightT?.objectId ?? snowflakeObjectId(conn.database, conn.schema, r.rightTable));
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

function manifestXml(materialization: SnowflakeMaterialization, relationshipPerf: boolean): string {
  const perf = relationshipPerf ? `    <ObjectModelRelationshipPerfOptions />\n` : '';
  const extractV2 = materialization === 'extract' ? `    <ObjectModelExtractV2 />\n` : '';
  const downstream =
    materialization === 'extract'
      ? `    <_.fcp.VConnDownstreamExtractsWithWarnings.true...VConnDownstreamExtractsWithWarnings />\n`
      : '';
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

function assertExtract(materialization: SnowflakeMaterialization, extract: { hyperDbname: string } | undefined): void {
  if (materialization === 'extract' && !extract?.hyperDbname) {
    throw new Error('Snowflake extract generation requires an extract.hyperDbname.');
  }
}

export type SnowflakeTwbType = TwbType;

export interface SnowflakeFieldIdentity {
  table: string;
  real: string;
  local: string;
  twb: SnowflakeTwbType;
}

export function snowflakeFieldIdentities(
  database: string,
  schema: string,
  tables: SnowflakeTableSpec[],
): SnowflakeFieldIdentity[] {
  return normalize(database, schema, tables).flatMap((t) =>
    t.fields.map((f) => ({ table: t.table, real: f.real, local: f.local, twb: f.twb })),
  );
}

export function generateSnowflakeTds(input: SnowflakeTdsInput): string {
  const table = String(input.table ?? '').trim();
  if (!table) throw new Error('generateSnowflakeTds requires a table.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(input.connection.database, input.connection.schema, [
    { table, columns: input.columns ?? [] },
  ]);
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || table;

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, extractRelationCollectionXml(norm))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, false) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(input.connection) +
    liveRelationXml(norm[0]!, input.connection, '    ') +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    objectGraphXml(norm, [], input.connection, input.materialization) +
    `</datasource>\n`
  );
}

export function generateSnowflakeRelationshipsTds(input: SnowflakeRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) throw new Error('generateSnowflakeRelationshipsTds requires at least two tables.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(input.connection.database, input.connection.schema, tables);
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || tables[0]?.table || '';

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, extractRelationCollectionXml(norm))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, true) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(input.connection) +
    liveRelationCollectionXml(norm, input.connection) +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    objectGraphXml(norm, input.relationships ?? [], input.connection, input.materialization) +
    `</datasource>\n`
  );
}

export function generateSnowflakePhysicalJoinTds(input: SnowflakeRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) throw new Error('generateSnowflakePhysicalJoinTds requires at least two tables.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(input.connection.database, input.connection.schema, tables);
  const relationships = input.relationships ?? [];
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || tables[0]?.table || '';

  const extractXml = isExtract
    ? extractElementXml(
        norm,
        input.extract!.hyperDbname,
        joinTreeXml(norm, relationships, input.connection, { live: false }, '      '),
      )
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, false) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(input.connection) +
    joinTreeXml(norm, relationships, input.connection, { live: true }) +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    `</datasource>\n`
  );
}
