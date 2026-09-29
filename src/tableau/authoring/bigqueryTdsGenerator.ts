/**
 * Deterministic Tableau datasource (`.tds`) generator for the Google BigQuery connector.
 *
 * Reconciled 1:1 against the two user-exported references
 * (`reference/BigQueryDatasetLive.tds` and `reference/BigQueryDatasetExtract.tds`) so we
 * never ask the LLM to author XML — the same discipline as the Salesforce/Excel generators.
 *
 * Unlike the Salesforce/Excel generators (whose fields are already identifier-safe), a
 * BigQuery column name may contain spaces or hyphens (e.g. `Order Date`, `Sub-Category`,
 * `Customer ID`). Tableau permits those verbatim inside bracketed identifiers, and the
 * reference keeps the REAL BigQuery name as both the connection `remote-name`/`remote-alias`
 * (so a LIVE connection — and an extract refresh — issue the correct `google-sql` SELECT)
 * and, disambiguated when duplicated across tables (`Region` -> `Region (People)`), as the
 * `local-name`. This generator therefore emits its OWN `<cols>` / `<metadata-records>` /
 * `<column>` / `<object-graph>` (rather than the identifier-only shared helpers in
 * `tdsGenerator.ts`), so it can keep real remote names while producing unique local names.
 * It DOES reuse the shared cardinality/join-type semantics and the `HyperColumnType` mapping.
 *
 * Two materializations are produced from the SAME model:
 *   - `live`   : no `<extract>`; the manifest omits `ObjectModelExtractV2`; the object-graph
 *                carries only `context=''`. Tableau queries BigQuery directly (OAuth).
 *   - `extract`: adds an `<extract class='hyper'>` over one `Extract."<objectId>"` table per
 *                table (columns keep their real names) plus `ObjectModelExtractV2` and a
 *                `context='extract'` object-graph property — mirroring the extract reference.
 *
 * The Salesforce and Excel connectors are untouched by this module.
 */
import { createHash } from 'node:crypto';
import { escapeXml } from './xml.js';
import type { SalesforceCardinality, SalesforceJoinType, HyperColumnType } from './tdsGenerator.js';

/** Stable internal named-connection id for generated BigQuery datasources. */
const BQ_CONNECTION_NAME = 'bigquery.tableaupilot';

/** Which data-access shape to publish. */
export type BigQueryMaterialization = 'live' | 'extract';

/** A described BigQuery column (real name + standard-SQL type). */
export interface BigQueryColumnSpec {
  /** Real BigQuery column name (used for `remote-name`/`remote-alias` + SQL). May contain spaces. */
  name: string;
  /** BigQuery standard-SQL scalar type (STRING, INT64, FLOAT64, NUMERIC, BOOL, DATE, TIMESTAMP, ...). */
  bqType: string;
  /** Whether the column is nullable (maps to `contains-null`). Defaults to true. */
  nillable?: boolean;
}

/** One BigQuery table participating in a datasource. */
export interface BigQueryTableSpec {
  /** Real BigQuery table id (e.g. `Orders`). */
  table: string;
  columns: BigQueryColumnSpec[];
}

/** The BigQuery connection coordinates (all non-secret; the OAuth token is embedded at publish). */
export interface BigQueryConnectionInfo {
  /** Billing/execution project id -> `EXECCATALOG`. */
  billingProjectId: string;
  /** Data project id -> `CATALOG` and the `[project.dataset]` relation prefix. */
  dataProjectId: string;
  /** Data project DISPLAY name -> the connection `project` attribute (e.g. `TableauAgent`). */
  dataProjectName: string;
  /** Dataset id -> the connection `schema` attribute and the `[project.dataset]` relation prefix. */
  datasetId: string;
  /** Signed-in Google account email -> the connection `username`. */
  username: string;
}

/** A data-modeling edge between two BigQuery tables (fields are real BigQuery names). */
export interface BigQueryRelationshipSpec {
  leftTable: string;
  leftField: string;
  rightTable: string;
  rightField: string;
  /** Relationships-model cardinality; defaults to `many-to-many`. */
  cardinality?: SalesforceCardinality;
  /** Physical-join model join type; defaults to `left`. */
  joinType?: SalesforceJoinType;
}

export interface BigQueryTdsInput {
  datasourceName: string;
  connection: BigQueryConnectionInfo;
  materialization: BigQueryMaterialization;
  /** The single table's real id + columns. */
  table: string;
  columns: BigQueryColumnSpec[];
  /** Required for `extract`: path of the `.hyper` inside the `.tdsx` (e.g. `Data/Extracts/x.hyper`). */
  extract?: { hyperDbname: string };
}

export interface BigQueryRelationshipsTdsInput {
  datasourceName: string;
  connection: BigQueryConnectionInfo;
  materialization: BigQueryMaterialization;
  /** The tables to combine (>= 2). */
  tables: BigQueryTableSpec[];
  /** The relationships connecting the tables into one graph. */
  relationships: BigQueryRelationshipSpec[];
  extract?: { hyperDbname: string };
}

type TwbType = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

/** Map a BigQuery standard-SQL type to a Tableau local datatype. */
function bqToTwbType(bqType: string): TwbType {
  switch ((bqType ?? '').toUpperCase()) {
    case 'INTEGER':
    case 'INT64':
      return 'integer';
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'DECIMAL':
    case 'BIGDECIMAL':
      return 'real';
    case 'BOOLEAN':
    case 'BOOL':
      return 'boolean';
    case 'DATE':
      return 'date';
    case 'DATETIME':
    case 'TIMESTAMP':
      return 'datetime';
    default:
      return 'string';
  }
}

/** Map a BigQuery standard-SQL type to the Hyper extract column category. */
export function bigQueryToHyperType(bqType: string): HyperColumnType {
  switch (bqToTwbType(bqType)) {
    case 'integer':
      return 'int';
    case 'real':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamp';
    default:
      return 'text';
  }
}

/**
 * Tableau OLE-DB remote-type code for a local datatype, using the SAME values the shared
 * Salesforce/Excel generators emit (proven to publish + refresh). The raw Desktop export
 * uses a few different codes (e.g. `7`/`129`), but those are advisory — Tableau re-resolves
 * metadata from the live connection / extract on publish.
 */
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
      return 130; // Unicode string
  }
}

/** Default aggregation per the reference: numeric -> Sum, date/datetime -> Year, else Count. */
function aggregationFor(twb: TwbType): string {
  if (twb === 'integer' || twb === 'real') return 'Sum';
  if (twb === 'date' || twb === 'datetime') return 'Year';
  return 'Count';
}

/**
 * Stable, identifier-safe per-table object id `<SafeTable>_<HASH>` (matching the reference
 * form `Orders_8CC6...`). Derived deterministically from the real table id so regenerating
 * the same table yields the same id. Used as the object-graph id, the `<extract>` object-id,
 * and the `Extract."<objectId>"` hyper table name (always identifier-safe).
 */
export function bigQueryObjectId(table: string): string {
  const safe = String(table ?? '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = /^[A-Za-z]/.test(safe) ? safe : `T_${safe}`;
  const hash = createHash('md5').update(String(table ?? '')).digest('hex').toUpperCase();
  return `${prefix || 'T'}_${hash}`;
}

/** A normalized column with a globally-unique local-name. */
interface NormField {
  real: string;
  local: string;
  twb: TwbType;
  bqType: string;
  nillable: boolean;
}

/** A normalized table with its object id + normalized fields. */
interface NormTable {
  table: string;
  objectId: string;
  fields: NormField[];
}

/**
 * Normalize the tables, assigning each column a globally-unique `local` name. The first
 * occurrence of a name keeps it verbatim; later duplicates become `Name (Table)` then
 * `Name (Table) 2`, ... — mirroring Tableau's own disambiguation (`Region (People)`).
 */
function normalize(tables: BigQueryTableSpec[]): NormTable[] {
  const usedLocals = new Set<string>();
  return tables.map((t) => {
    const objectId = bigQueryObjectId(t.table);
    const fields = (t.columns ?? []).map((c) => {
      const real = String(c.name ?? '');
      let local = real;
      if (usedLocals.has(local)) {
        local = `${real} (${t.table})`;
        let n = 2;
        while (usedLocals.has(local)) local = `${real} (${t.table}) ${n++}`;
      }
      usedLocals.add(local);
      const twb = bqToTwbType(c.bqType);
      return { real, local, twb, bqType: c.bqType, nillable: c.nillable !== false };
    });
    return { table: t.table, objectId, fields };
  });
}

/** Look up a field's local-name by (table, realField). */
function localOf(norm: NormTable[], table: string, field: string): string {
  const t = norm.find((x) => x.table === table);
  const f = t?.fields.find((x) => x.real === field);
  return f?.local ?? field;
}

// --- Connection block ---------------------------------------------------------------------

/** The `bigquery` named-connection block (OAuth; the token is embedded at publish time). */
function namedConnectionXml(conn: BigQueryConnectionInfo): string {
  return (
    `    <named-connections>\n` +
    `      <named-connection caption='BigQuery' name='${BQ_CONNECTION_NAME}'>\n` +
    `        <connection CATALOG='${escapeXml(conn.dataProjectId)}' EXECCATALOG='${escapeXml(conn.billingProjectId)}' ` +
    `authentication='oauth' class='bigquery' connection-dialect='google-sql' project='${escapeXml(conn.dataProjectName)}' ` +
    `schema='${escapeXml(conn.datasetId)}' server-oauth='' username='${escapeXml(conn.username)}' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n`
  );
}

/** The `[project.dataset]` catalog.schema prefix used in every physical relation `table`. */
function relationPrefix(conn: BigQueryConnectionInfo): string {
  return `${conn.dataProjectId}.${conn.datasetId}`;
}

/** A single live physical `<relation>` for a table. */
function liveRelationXml(table: string, conn: BigQueryConnectionInfo, indent: string): string {
  const t = escapeXml(table);
  const prefix = escapeXml(relationPrefix(conn));
  return `${indent}<relation connection='${BQ_CONNECTION_NAME}' name='${t}' table='[${prefix}].[${t}]' type='table' />\n`;
}

/** Live `<relation type='collection'>` (one relation per table) for the relationships model. */
function liveRelationCollectionXml(tables: NormTable[], conn: BigQueryConnectionInfo, indent = '    '): string {
  const inner = indent + '  ';
  const rels = tables.map((t) => liveRelationXml(t.table, conn, inner)).join('');
  return `${indent}<relation type='collection'>\n` + rels + `${indent}</relation>\n`;
}

/** Connection-level merged `<cols>` (`[local]` -> `[Table].[realField]`). */
function colsXml(tables: NormTable[], indent = '    '): string {
  const inner = indent + '  ';
  const maps: string[] = [];
  for (const t of tables) {
    for (const f of t.fields) {
      maps.push(`${inner}<map key='[${escapeXml(f.local)}]' value='[${escapeXml(t.table)}].[${escapeXml(f.real)}]' />\n`);
    }
  }
  if (maps.length === 0) return '';
  return `${indent}<cols>\n` + maps.join('') + `${indent}</cols>\n`;
}

/** One connection-level `<metadata-record>` (real remote-name, unique local-name, real parent table). */
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

/** Connection-level `<metadata-records>` block (parent = the real table name). */
function metadataRecordsXml(tables: NormTable[], indent = '    '): string {
  const inner = indent + '  ';
  const blocks = tables
    .map((t) => t.fields.map((f) => metadataRecordXml(f, t.table, inner)).join(''))
    .join('');
  if (!blocks) return '';
  return `${indent}<metadata-records>\n` + blocks + `${indent}</metadata-records>\n`;
}

/** Datasource-level `<column>` elements (one per column), named by the unique local-name. */
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

// --- Extract block ------------------------------------------------------------------------

/** Extract `<relation type='collection'>` over one `Extract."<objectId>"` table per table. */
function extractRelationCollectionXml(tables: NormTable[], indent = '      '): string {
  const inner = indent + '  ';
  const rels = tables
    .map((t) => `${inner}<relation name='${escapeXml(t.objectId)}' table='[Extract].[${escapeXml(t.objectId)}]' type='table' />\n`)
    .join('');
  return `${indent}<relation type='collection'>\n` + rels + `${indent}</relation>\n`;
}

/** Extract-level `<cols>` (`[local]` -> `[objectId].[realField]`). */
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

/** Extract-level `<metadata-records>` (parent = the extract objectId). */
function extractMetadataRecordsXml(tables: NormTable[], indent = '      '): string {
  const inner = indent + '  ';
  const blocks = tables
    .map((t) => t.fields.map((f) => metadataRecordXml(f, t.objectId, inner)).join(''))
    .join('');
  if (!blocks) return '';
  return `${indent}<metadata-records>\n` + blocks + `${indent}</metadata-records>\n`;
}

/** The `<extract class='hyper'>` element whose relation block is supplied by the caller. */
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

// --- Physical join tree -------------------------------------------------------------------

/**
 * Left-deep `<relation type='join'>` tree flattening the tables in order. `live` leaves
 * reference the BigQuery connection (`[project.dataset].[Table]`, name = real table); extract
 * leaves reference `[Extract].[objectId]` (name = objectId). The join clause references the
 * matching leaf `name`s (real table for live, objectId for extract).
 */
function joinTreeXml(
  tables: NormTable[],
  relationships: BigQueryRelationshipSpec[],
  conn: BigQueryConnectionInfo,
  opts: { live: boolean },
  indent = '    ',
): string {
  const relByRight = new Map(relationships.map((r) => [r.rightTable, r]));
  const leaf = (t: NormTable, ind: string): string =>
    opts.live ? liveRelationXml(t.table, conn, ind) : `${ind}<relation name='${escapeXml(t.objectId)}' table='[Extract].[${escapeXml(t.objectId)}]' type='table' />\n`;

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

/** `<clause type='join'>` over the two physical `[parent].[field]` columns of a join edge. */
function joinClauseXml(
  rel: BigQueryRelationshipSpec | undefined,
  tables: NormTable[],
  live: boolean,
  indent: string,
): string {
  const inner = indent + '  ';
  const innerer = inner + '  ';
  const parent = (table: string): string => {
    if (live) return table;
    return tables.find((t) => t.table === table)?.objectId ?? table;
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

// --- Object graph -------------------------------------------------------------------------

/**
 * The trailing `<object-graph>`: one `<object>` per table (with a `context=''` live property
 * and, for extracts, a `context='extract'` property) plus one `<relationship>` per edge. The
 * relationship expressions reference the disambiguated LOCAL field names.
 */
function objectGraphXml(
  tables: NormTable[],
  relationships: BigQueryRelationshipSpec[],
  conn: BigQueryConnectionInfo,
  materialization: BigQueryMaterialization,
): string {
  const prefix = escapeXml(relationPrefix(conn));
  const objectsXml = tables
    .map((t) => {
      const real = escapeXml(t.table);
      const oid = escapeXml(t.objectId);
      const extractProps =
        materialization === 'extract'
          ? `        <properties context='extract'>\n` +
            `          <relation name='${oid}' table='[Extract].[${oid}]' type='table' />\n` +
            `        </properties>\n`
          : '';
      return (
        `      <object caption='${real}' id='${oid}'>\n` +
        `        <properties context=''>\n` +
        `          <relation connection='${BQ_CONNECTION_NAME}' name='${real}' table='[${prefix}].[${real}]' type='table' />\n` +
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
      const leftId = escapeXml(bigQueryObjectId(r.leftTable));
      const rightId = escapeXml(bigQueryObjectId(r.rightTable));
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

// --- Manifest -----------------------------------------------------------------------------

/**
 * The `<document-format-change-manifest>`. The `extract` form adds `ObjectModelExtractV2`
 * (+ the downstream-extract warning flag) exactly as the extract reference; the `live` form
 * omits them (as the live reference does). `relationshipPerf` adds the perf-options flag for
 * multi-table (relationships) datasources.
 */
function manifestXml(materialization: BigQueryMaterialization, relationshipPerf: boolean): string {
  const perf = relationshipPerf ? `    <ObjectModelRelationshipPerfOptions />\n` : '';
  const extractV2 = materialization === 'extract' ? `    <ObjectModelExtractV2 />\n` : '';
  const downstream = materialization === 'extract' ? `    <VConnDownstreamExtractsWithWarnings />\n` : '';
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

function assertExtract(materialization: BigQueryMaterialization, extract: { hyperDbname: string } | undefined): void {
  if (materialization === 'extract' && !extract?.hyperDbname) {
    throw new Error('BigQuery extract generation requires an extract.hyperDbname.');
  }
}

// --- Field identities (for datasource metadata) -------------------------------------------

/** The Tableau local datatype family used for a BigQuery column (exported for metadata mapping). */
export type BigQueryTwbType = TwbType;

/** One field's identity as it appears in the generated `.tds` (for building DatasourceMetadata). */
export interface BigQueryFieldIdentity {
  table: string;
  /** Real BigQuery column name. */
  real: string;
  /** Disambiguated Tableau local-name — the field's identity in the published datasource. */
  local: string;
  /** Tableau local datatype family. */
  twb: BigQueryTwbType;
}

/**
 * Compute the field identities (disambiguated local-names + datatypes) for the given tables,
 * using the SAME normalization the generators use. The dashboard flow builds its metadata
 * from these so field references match the published datasource's column identities exactly.
 */
export function bigQueryFieldIdentities(tables: BigQueryTableSpec[]): BigQueryFieldIdentity[] {
  return normalize(tables).flatMap((t) =>
    t.fields.map((f) => ({ table: t.table, real: f.real, local: f.local, twb: f.twb })),
  );
}

// --- Public generators --------------------------------------------------------------------

/** Generate a `.tds` for a SINGLE-table BigQuery datasource (live or extract). */
export function generateBigQueryTds(input: BigQueryTdsInput): string {
  const table = String(input.table ?? '').trim();
  if (!table) throw new Error('generateBigQueryTds requires a table.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize([{ table, columns: input.columns ?? [] }]);
  const conn = input.connection;
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || table;

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, extractRelationCollectionXml(norm))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, false) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(conn) +
    liveRelationXml(table, conn, '    ') +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    objectGraphXml(norm, [], conn, input.materialization) +
    `</datasource>\n`
  );
}

/** Generate a `.tds` for a multi-table BigQuery datasource using the relationships (object-graph) model. */
export function generateBigQueryRelationshipsTds(input: BigQueryRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) throw new Error('generateBigQueryRelationshipsTds requires at least two tables.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(tables);
  const conn = input.connection;
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || tables[0]?.table || '';

  const extractXml = isExtract
    ? extractElementXml(norm, input.extract!.hyperDbname, extractRelationCollectionXml(norm))
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, true) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(conn) +
    liveRelationCollectionXml(norm, conn) +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    objectGraphXml(norm, input.relationships ?? [], conn, input.materialization) +
    `</datasource>\n`
  );
}

/** Generate a `.tds` for a multi-table BigQuery datasource using a PHYSICAL join (no object-graph). */
export function generateBigQueryPhysicalJoinTds(input: BigQueryRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) throw new Error('generateBigQueryPhysicalJoinTds requires at least two tables.');
  assertExtract(input.materialization, input.extract);
  const norm = normalize(tables);
  const conn = input.connection;
  const relationships = input.relationships ?? [];
  const isExtract = input.materialization === 'extract';
  const formattedName = input.datasourceName || tables[0]?.table || '';

  const extractXml = isExtract
    ? extractElementXml(
        norm,
        input.extract!.hyperDbname,
        joinTreeXml(norm, relationships, conn, { live: false }, '      '),
      )
    : '';

  return (
    header(formattedName) +
    manifestXml(input.materialization, false) +
    `  <connection class='federated'>\n` +
    namedConnectionXml(conn) +
    joinTreeXml(norm, relationships, conn, { live: true }) +
    colsXml(norm) +
    metadataRecordsXml(norm) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml(norm) +
    extractXml +
    `</datasource>\n`
  );
}
