/**
 * Deterministic Tableau datasource (`.tds`) generator for the Salesforce connector.
 *
 * Mirrors the connection block of the user's real exported reference
 * (`reference/Salesforce_Account_DS.tdsx` -> embedded `.tds`) so we never ask the
 * LLM to author XML (same discipline as `twbGenerator.ts`).
 *
 * RECONCILED against the reference. Ground truth observed there:
 *   <connection class='federated'>
 *     <named-connections>
 *       <named-connection caption='<host>.my.salesforce.com' name='salesforce.<id>'>
 *         <connection authentication='auth-oauth' class='salesforce'
 *           compressed-responses='yes' compressed-responses-bulk='yes'
 *           compressed-responses-rest='yes' compressed-responses-soap='yes'
 *           maxfieldlength='4096' pagesize='200' salesforce-api-version='68.0'
 *           server='<host>.my.salesforce.com' server-oauth='server-custom'
 *           sf-total-requestor-buffer-size-in-mb='32' username='<user>' />
 *       </named-connection>
 *     </named-connections>
 *     <relation connection='salesforce.<id>' name='Account' table='[Account]' type='table' />
 *   </connection>
 *
 * The reference is EXTRACT-backed (it embeds a `.hyper` + a `class='hyper'`
 * connection inside an `<extract>` element). We intentionally generate a LIVE
 * datasource (no `<extract>`): the "no Python / no local Hyper" invariant means we
 * cannot build a `.hyper` for a different object locally. A live Salesforce OAuth
 * connection can optionally be materialized into an extract server-side later via
 * the REST `createExtract` endpoint (no local Hyper needed).
 *
 * Because the connection is OAuth, publishing reuses the site's Salesforce OAuth
 * saved credential (see `publishDatasource` -> `connectionCredentials.oAuth`), not
 * an embedded username/password.
 */
import { createHash } from 'node:crypto';
import { escapeXml } from './xml.js';

/** Internal, stable named-connection id for generated Salesforce datasources. */
const CONNECTION_NAME = 'salesforce.tableaupilot';

/**
 * Which credential model the published datasource uses.
 * - `oauth`: Tableau `authentication='auth-oauth'` (+ `server-oauth='server-custom'`),
 *   matching the reference. Publish embeds a saved Salesforce OAuth credential.
 * - `username-password`: Tableau `authentication='auth-user-pass'` (traditional
 *   Salesforce username/password). Publish embeds the entered username/password.
 * (Values per Tableau's connector auth-modes; the built-in Salesforce connector
 * prefixes OAuth as `auth-oauth`, confirmed by the exported reference.)
 */
export type SalesforceAuthMode = 'oauth' | 'username-password';

/** Default auth mode (mirrors the working reference datasource). */
export const DEFAULT_SALESFORCE_AUTH_MODE: SalesforceAuthMode = 'oauth';

/** Salesforce connector API version declared on the connection (from the reference). */
export const DEFAULT_SALESFORCE_API_VERSION = '68.0';

/**
 * The `<document-format-change-manifest>` that marks a datasource as using Tableau's V2
 * object model + extract-V2. BOTH working references emit this as the FIRST child of
 * `<datasource>` (`reference/sample_datasource_DataModelling.tds` and the embedded `.tds`
 * in `reference/Salesforce_Account_DS.tdsx`). WITHOUT it, Tableau loads an extract-backed
 * datasource in LEGACY mode and flattens every table into a single "Migrated Data" table,
 * silently discarding the `<object-graph>` (this was the relationship-vs-migrated-data bug).
 *
 * `relationshipPerf` adds `<ObjectModelRelationshipPerfOptions />`, which is present in the
 * relationships reference but absent from the single-object one; the other flags are shared.
 */
function documentFormatChangeManifestXml(relationshipPerf = false): string {
  const perf = relationshipPerf ? `    <ObjectModelRelationshipPerfOptions />\n` : '';
  return (
    `  <document-format-change-manifest>\n` +
    `    <ObjectModelEncapsulateLegacy />\n` +
    `    <ObjectModelExtractV2 />\n` +
    perf +
    `    <ObjectModelTableType />\n` +
    `    <SchemaViewerObjectModel />\n` +
    `    <VConnDownstreamExtractsWithWarnings />\n` +
    `  </document-format-change-manifest>\n`
  );
}

/** The Tableau `authentication` attribute value for a given auth mode. */
export function authAttrForMode(mode: SalesforceAuthMode): string {
  return mode === 'username-password' ? 'auth-user-pass' : 'auth-oauth';
}

/** A described Salesforce field, emitted as connection column metadata + a datasource column. */
export interface SalesforceColumnSpec {
  /** Salesforce field API name, e.g. "Name" or "AnnualRevenue". */
  name: string;
  /** Salesforce field type, e.g. string, boolean, double, date, datetime, id. */
  salesforceType: string;
  /** Whether the field is nullable (maps to `contains-null`). Defaults to true. */
  nillable?: boolean;
}

export interface SalesforceTdsInput {
  /** Display/caption name of the datasource (also its formatted-name seed). */
  datasourceName: string;
  /**
   * Salesforce instance host used for the connection `server` attribute, e.g.
   * `storm-xxxx.my.salesforce.com` (the resolved My Domain / instance host from the
   * live Salesforce session, NOT the generic login host).
   */
  serverHost: string;
  /** Salesforce username used for the connection (no secret). */
  username: string;
  /** Selected Salesforce object (SObject) API name, e.g. "Account". */
  object: string;
  /** Credential model for the connection; defaults to {@link DEFAULT_SALESFORCE_AUTH_MODE}. */
  authMode?: SalesforceAuthMode;
  /**
   * For OAuth connections, whether to emit `server-oauth='server-custom'` (a custom
   * Salesforce OAuth client registered on the Tableau site, as in the reference).
   * Set false to use Tableau's built-in Salesforce OAuth client. Ignored for the
   * username/password auth mode. Defaults to true.
   */
  serverOauthCustom?: boolean;
  /** Salesforce connector API version; defaults to {@link DEFAULT_SALESFORCE_API_VERSION}. */
  salesforceApiVersion?: string;
  /**
   * Optional field list (from describeObject, with compound/blob types already excluded).
   * When provided, these are emitted as connection-level `<cols>` + `<metadata-records>`
   * plus datasource-level `<column>` elements, and (when {@link extract} is set) as the
   * extract's schema.
   */
  fields?: SalesforceColumnSpec[];
  /**
   * When set, emit an `<extract enabled='true'>` element backed by a locally built
   * `.hyper` (packaged into the `.tdsx` at `hyperDbname`). The datasource then reads
   * from the extract; the live Salesforce connection is retained for schema/lineage.
   */
  extract?: {
    /** Path of the `.hyper` inside the `.tdsx`, e.g. `Data/Extracts/federated_x.hyper`. */
    hyperDbname: string;
  };
}

type TwbType = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

/** Hyper extract column category understood by `scripts/hyper/build_tdsx.py`. */
export type HyperColumnType = 'text' | 'int' | 'double' | 'bool' | 'date' | 'timestamp';

/** Map a Salesforce soap field type to the Hyper extract column category. */
export function salesforceToHyperType(salesforceType: string): HyperColumnType {
  switch (salesforceToTwbDataType(salesforceType)) {
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

/** Map a Salesforce soap field type to a Tableau column datatype (for future column emission). */
export function salesforceToTwbDataType(salesforceType: string): TwbType {
  switch ((salesforceType ?? '').toLowerCase()) {
    case 'boolean':
      return 'boolean';
    case 'int':
    case 'integer':
      return 'integer';
    case 'double':
    case 'currency':
    case 'percent':
      return 'real';
    case 'date':
      return 'date';
    case 'datetime':
    case 'time':
      return 'datetime';
    default:
      // id, string, textarea, phone, email, url, picklist, multipicklist,
      // reference, combobox, encryptedstring, base64, anyType, address, location…
      return 'string';
  }
}

/**
 * Generate a `.tds` XML string for a single-object, LIVE Salesforce datasource.
 *
 * The connection is `class='federated'` wrapping the `class='salesforce'`
 * OAuth named-connection observed in the reference, with a single `relation` for
 * the chosen object. Physical/logical schema is resolved by Tableau from the live
 * connection at publish/open time.
 */
export function generateSalesforceTds(input: SalesforceTdsInput): string {
  const object = String(input.object ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object)) {
    throw new Error(`Invalid Salesforce object name for datasource generation: ${object}`);
  }
  const authMode = input.authMode ?? DEFAULT_SALESFORCE_AUTH_MODE;
  const auth = authAttrForMode(authMode);
  const apiVersion = input.salesforceApiVersion ?? DEFAULT_SALESFORCE_API_VERSION;
  const formattedName = escapeXml(input.datasourceName || object);
  const serverHost = escapeXml(input.serverHost);
  const username = escapeXml(input.username);
  const objName = escapeXml(object);
  // OAuth connections carry server-oauth='server-custom' (as in the reference) when a
  // custom Salesforce OAuth client is registered on the site; traditional
  // username/password connections never do.
  const serverOauthAttr =
    authMode === 'oauth' && input.serverOauthCustom !== false ? `server-oauth='server-custom' ` : '';

  // Field-derived XML. `fields` come from describe (compound/blob types already excluded
  // upstream), so the metadata below only lists Bulk-queryable columns — this is what
  // constrains Tableau's server-side `createExtract` SELECT and avoids sf:MALFORMED_QUERY.
  const validFields = (input.fields ?? []).filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.name ?? '')));

  // Connection-level column metadata (mirrors the reference `.tds`): a <cols> alias map
  // plus a <metadata-record> per field. Emitted INSIDE <connection class='federated'>.
  const objectId = salesforceObjectId(object);
  const colsXml = colsMapXml(validFields, objName);
  const metadataXml = metadataRecordsXml(validFields, object, objectId);

  // Datasource-level column declarations (role/datatype) so fields surface immediately.
  const columnsXml = validFields.map((f) => `  ${columnElement(f)}\n`).join('');

  // Optional extract element backed by a locally built `.hyper` (packaged in the .tdsx).
  const extractXml = input.extract
    ? extractElementXml(validFields, object, objName, objectId, input.extract.hyperDbname)
    : '';

  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${formattedName}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n` +
    documentFormatChangeManifestXml() +
    `  <connection class='federated'>\n` +
    `    <named-connections>\n` +
    `      <named-connection caption='${serverHost}' name='${CONNECTION_NAME}'>\n` +
    `        <connection authentication='${auth}' class='salesforce' ` +
    `compressed-responses='yes' compressed-responses-bulk='yes' compressed-responses-rest='yes' compressed-responses-soap='yes' ` +
    `maxfieldlength='4096' pagesize='200' salesforce-api-version='${escapeXml(apiVersion)}' ` +
    `server='${serverHost}' ${serverOauthAttr}sf-total-requestor-buffer-size-in-mb='32' username='${username}' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n` +
    `    <relation connection='${CONNECTION_NAME}' name='${objName}' table='[${objName}]' type='table' />\n` +
    colsXml +
    metadataXml +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsXml +
    extractXml +
    `</datasource>\n`
  );
}

/** Relationship cardinality; maps onto Tableau end-point `unique-key` flags. */
export type SalesforceCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

/** SQL join type for the physical-join model; emitted verbatim as the `join='...'` attribute. */
export type SalesforceJoinType = 'inner' | 'left' | 'right' | 'full';

/** One object participating in a multi-table (relationships) datasource. */
export interface SalesforceTableSpec {
  /** Salesforce object (SObject) API name, e.g. `Account`. */
  object: string;
  /** Described fields (compound/blob already excluded upstream). */
  fields: SalesforceColumnSpec[];
}

/** One data-modeling edge: a matching field pair between two objects + cardinality. */
export interface SalesforceRelationshipSpec {
  leftObject: string;
  leftField: string;
  rightObject: string;
  rightField: string;
  /** Relationships-model cardinality; defaults to `many-to-many` (neither side unique). */
  cardinality?: SalesforceCardinality;
  /** Physical-join model join type; defaults to `left`. Ignored by the relationships model. */
  joinType?: SalesforceJoinType;
}

export interface SalesforceRelationshipsTdsInput {
  /** Display/caption name of the datasource. */
  datasourceName: string;
  /** Resolved Salesforce instance host for the connection `server` attribute. */
  serverHost: string;
  /** Salesforce username used for the connection (no secret). */
  username: string;
  /** Credential model; defaults to {@link DEFAULT_SALESFORCE_AUTH_MODE}. */
  authMode?: SalesforceAuthMode;
  /** For OAuth, emit `server-oauth='server-custom'` (defaults true). */
  serverOauthCustom?: boolean;
  /** Salesforce connector API version; defaults to {@link DEFAULT_SALESFORCE_API_VERSION}. */
  salesforceApiVersion?: string;
  /** The objects to join (>= 2). */
  tables: SalesforceTableSpec[];
  /** The relationships connecting the objects into one graph. */
  relationships: SalesforceRelationshipSpec[];
  /** Extract packaging: path of the `.hyper` inside the `.tdsx`. */
  extract: { hyperDbname: string };
}

/** Stable, unique per-column alias used as the `<cols>` key / logical `<column>` name. */
function aliasFor(object: string, field: string): string {
  return `${object}.${field}`;
}

/** Fields with a valid Salesforce API name (defensive; matches single-object generator). */
function validColumns(fields: SalesforceColumnSpec[]): SalesforceColumnSpec[] {
  return (fields ?? []).filter((f) => /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.name ?? '')));
}

/**
 * Generate a `.tds` for a multi-object, EXTRACT-backed Salesforce datasource using
 * Tableau's relationships (object-graph) model — modeled 1:1 on the reference
 * `reference/sample_datasource_DataModelling.tds`. Each object is its own physical
 * `<relation type='table'>` (inside a `<relation type='collection'>`) and its own
 * `Extract."<Object>"` table; the joins live only in the trailing `<object-graph>`.
 */
export function generateSalesforceRelationshipsTds(input: SalesforceRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) {
    throw new Error('generateSalesforceRelationshipsTds requires at least two tables.');
  }
  for (const t of tables) {
    const object = String(t.object ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object)) {
      throw new Error(`Invalid Salesforce object name for datasource generation: ${t.object}`);
    }
  }
  const authMode = input.authMode ?? DEFAULT_SALESFORCE_AUTH_MODE;
  const auth = authAttrForMode(authMode);
  const apiVersion = input.salesforceApiVersion ?? DEFAULT_SALESFORCE_API_VERSION;
  const formattedName = escapeXml(input.datasourceName || tables[0]?.object || '');
  const serverHost = escapeXml(input.serverHost);
  const username = escapeXml(input.username);
  const serverOauthAttr =
    authMode === 'oauth' && input.serverOauthCustom !== false ? `server-oauth='server-custom' ` : '';

  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${formattedName}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n` +
    documentFormatChangeManifestXml(true) +
    `  <connection class='federated'>\n` +
    `    <named-connections>\n` +
    `      <named-connection caption='${serverHost}' name='${CONNECTION_NAME}'>\n` +
    `        <connection authentication='${auth}' class='salesforce' ` +
    `compressed-responses='yes' compressed-responses-bulk='yes' compressed-responses-rest='yes' compressed-responses-soap='yes' ` +
    `maxfieldlength='4096' pagesize='200' salesforce-api-version='${escapeXml(apiVersion)}' ` +
    `server='${serverHost}' ${serverOauthAttr}sf-total-requestor-buffer-size-in-mb='32' username='${username}' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n` +
    relationCollectionXml(tables, CONNECTION_NAME) +
    colsMapMultiXml(tables) +
    metadataRecordsMultiXml(tables, '    ') +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsMultiXml(tables) +
    extractElementMultiXml(tables, input.extract.hyperDbname) +
    objectGraphXml(tables, input.relationships ?? [], CONNECTION_NAME) +
    `</datasource>\n`
  );
}

/**
 * Generate a `.tds` for a multi-object, EXTRACT-backed Salesforce datasource using a
 * PHYSICAL join (Tableau's classic join canvas) rather than the relationships model.
 * The objects are flattened via a left-deep tree of `<relation type='join' join='...'>`
 * in BOTH the federated (live) connection and the `<extract>` `class='hyper'` connection
 * (over the same N `Extract."<Object>"` tables the relationships model uses). There is NO
 * trailing `<object-graph>` — the join lives entirely in the physical relation.
 */
export function generateSalesforcePhysicalJoinTds(input: SalesforceRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) {
    throw new Error('generateSalesforcePhysicalJoinTds requires at least two tables.');
  }
  for (const t of tables) {
    const object = String(t.object ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(object)) {
      throw new Error(`Invalid Salesforce object name for datasource generation: ${t.object}`);
    }
  }
  const relationships = input.relationships ?? [];
  const authMode = input.authMode ?? DEFAULT_SALESFORCE_AUTH_MODE;
  const auth = authAttrForMode(authMode);
  const apiVersion = input.salesforceApiVersion ?? DEFAULT_SALESFORCE_API_VERSION;
  const formattedName = escapeXml(input.datasourceName || tables[0]?.object || '');
  const serverHost = escapeXml(input.serverHost);
  const username = escapeXml(input.username);
  const serverOauthAttr =
    authMode === 'oauth' && input.serverOauthCustom !== false ? `server-oauth='server-custom' ` : '';

  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${formattedName}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n` +
    documentFormatChangeManifestXml() +
    `  <connection class='federated'>\n` +
    `    <named-connections>\n` +
    `      <named-connection caption='${serverHost}' name='${CONNECTION_NAME}'>\n` +
    `        <connection authentication='${auth}' class='salesforce' ` +
    `compressed-responses='yes' compressed-responses-bulk='yes' compressed-responses-rest='yes' compressed-responses-soap='yes' ` +
    `maxfieldlength='4096' pagesize='200' salesforce-api-version='${escapeXml(apiVersion)}' ` +
    `server='${serverHost}' ${serverOauthAttr}sf-total-requestor-buffer-size-in-mb='32' username='${username}' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n` +
    joinRelationTreeXml(tables, relationships, { connectionName: CONNECTION_NAME }) +
    colsMapMultiXml(tables) +
    metadataRecordsMultiXml(tables, '    ') +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsMultiXml(tables) +
    extractElementWithRelationXml(
      tables,
      input.extract.hyperDbname,
      joinRelationTreeXml(tables, relationships, {}, '      '),
    ) +
    `</datasource>\n`
  );
}

/**
 * A left-deep tree of `<relation type='join'>` flattening the objects in `tables` order.
 * Each table after the first is joined to the accumulated left side via the relationship
 * whose `rightObject` is that table. When `opts.connectionName` is set the leaves reference
 * the LIVE tables (`connection=... table='[Object]'`); otherwise they reference the extract
 * tables (`table='[Extract].[Object]'`). The join clause is identical in both cases.
 */
function joinRelationTreeXml(
  tables: SalesforceTableSpec[],
  relationships: SalesforceRelationshipSpec[],
  opts: { connectionName?: string },
  indent = '    ',
): string {
  const relByRight = new Map(relationships.map((r) => [r.rightObject, r]));
  const leafXml = (object: string, ind: string): string => {
    const n = escapeXml(object);
    return opts.connectionName
      ? `${ind}<relation connection='${escapeXml(opts.connectionName)}' name='${n}' table='[${n}]' type='table' />\n`
      : `${ind}<relation name='${n}' table='[Extract].[${n}]' type='table' />\n`;
  };
  const buildNode = (k: number, ind: string): string => {
    const object = String(tables[k]?.object ?? '');
    if (k === 0) return leafXml(object, ind);
    const rel = relByRight.get(object);
    const joinType: SalesforceJoinType = rel?.joinType ?? 'left';
    const inner = ind + '  ';
    return (
      `${ind}<relation join='${joinType}' type='join'>\n` +
      buildNode(k - 1, inner) +
      leafXml(object, inner) +
      joinClauseXml(rel, inner) +
      `${ind}</relation>\n`
    );
  };
  return buildNode(tables.length - 1, indent);
}

/** `<clause type='join'>` with an `=` expression over the two PHYSICAL `[Object].[Field]` columns. */
function joinClauseXml(rel: SalesforceRelationshipSpec | undefined, indent: string): string {
  const inner = indent + '  ';
  const innerer = inner + '  ';
  const left = rel ? `[${escapeXml(rel.leftObject)}].[${escapeXml(rel.leftField)}]` : '';
  const right = rel ? `[${escapeXml(rel.rightObject)}].[${escapeXml(rel.rightField)}]` : '';
  return (
    `${indent}<clause type='join'>\n` +
    `${inner}<expression op='='>\n` +
    `${innerer}<expression op='${left}' />\n` +
    `${innerer}<expression op='${right}' />\n` +
    `${inner}</expression>\n` +
    `${indent}</clause>\n`
  );
}

/** Physical `<relation type='collection'>` of one table relation per object. */
function relationCollectionXml(tables: SalesforceTableSpec[], connectionName: string, indent = '    '): string {
  const inner = indent + '  ';
  const rels = tables
    .map((t) => {
      const n = escapeXml(t.object);
      return `${inner}<relation connection='${connectionName}' name='${n}' table='[${n}]' type='table' />\n`;
    })
    .join('');
  return `${indent}<relation type='collection'>\n` + rels + `${indent}</relation>\n`;
}

/** Merged `<cols>` alias map (`[Object.Field]` -> `[Object].[Field]`) across all objects. */
function colsMapMultiXml(tables: SalesforceTableSpec[], indent = '    '): string {
  const inner = indent + '  ';
  const maps: string[] = [];
  for (const t of tables) {
    const objName = escapeXml(t.object);
    for (const f of validColumns(t.fields)) {
      const alias = escapeXml(aliasFor(t.object, f.name));
      maps.push(`${inner}<map key='[${alias}]' value='[${objName}].[${escapeXml(f.name)}]' />\n`);
    }
  }
  if (maps.length === 0) return '';
  return `${indent}<cols>\n` + maps.join('') + `${indent}</cols>\n`;
}

/** Merged `<metadata-records>` (one record per column, across all objects). */
function metadataRecordsMultiXml(tables: SalesforceTableSpec[], indent = '    '): string {
  const inner = indent + '  ';
  const blocks = tables
    .map((t) => {
      const objectId = salesforceObjectId(t.object);
      return validColumns(t.fields)
        // Unique `Object.Field` local-name so duplicate API names (e.g. `Id`) across objects
        // don't collide -> avoids Tableau's "Duplicate field name" load/refresh error.
        .map((f) => metadataRecord(f, t.object, objectId, inner, aliasFor(t.object, f.name)))
        .join('');
    })
    .join('');
  if (!blocks) return '';
  return `${indent}<metadata-records>\n` + blocks + `${indent}</metadata-records>\n`;
}

/** Datasource-level `<column>` elements (one per column) named by their unique alias. */
function columnsMultiXml(tables: SalesforceTableSpec[]): string {
  let out = '';
  for (const t of tables) {
    for (const f of validColumns(t.fields)) {
      out += `  ${columnElementAliased(f, aliasFor(t.object, f.name))}\n`;
    }
  }
  return out;
}

/** `<extract>` with a `class='hyper'` connection over N `Extract."<Object>"` tables (relationships model). */
function extractElementMultiXml(tables: SalesforceTableSpec[], hyperDbname: string): string {
  const relations = tables
    .map((t) => {
      const n = escapeXml(t.object);
      return `        <relation name='${n}' table='[Extract].[${n}]' type='table' />\n`;
    })
    .join('');
  const collection = `      <relation type='collection'>\n` + relations + `      </relation>\n`;
  return extractElementWithRelationXml(tables, hyperDbname, collection);
}

/**
 * `<extract>` with a `class='hyper'` connection whose relation block is supplied by the
 * caller (a `<relation type='collection'>` for the relationships model, or a
 * `<relation type='join'>` tree for the physical-join model). `relationXml` must already be
 * indented to sit inside the `<connection>` (6 spaces). The merged `<cols>`/`<metadata-records>`
 * use the same qualified `[Object.Field]` aliases as the physical connection.
 */
function extractElementWithRelationXml(
  tables: SalesforceTableSpec[],
  hyperDbname: string,
  relationXml: string,
): string {
  return (
    `  <extract count='-1' enabled='true' object-id='' units='records' user-specific='false'>\n` +
    `    <connection authentication='auth-none' class='hyper' dbname='${escapeXml(hyperDbname)}' ` +
    `default-settings='yes' schema='Extract' tablename='Extract'>\n` +
    relationXml +
    colsMapMultiXml(tables, '      ') +
    metadataRecordsMultiXml(tables, '      ') +
    `    </connection>\n` +
    `  </extract>\n`
  );
}

/** The trailing `<object-graph>` (logical model): objects + relationships with cardinality. */
function objectGraphXml(
  tables: SalesforceTableSpec[],
  relationships: SalesforceRelationshipSpec[],
  connectionName: string,
): string {
  const bareId = (object: string): string => salesforceObjectId(object).replace(/^\[|\]$/g, '');

  const objectsXml = tables
    .map((t) => {
      const n = escapeXml(t.object);
      const id = escapeXml(bareId(t.object));
      return (
        `      <object caption='${n}' id='${id}'>\n` +
        `        <properties context=''>\n` +
        `          <relation connection='${connectionName}' name='${n}' table='[${n}]' type='table' />\n` +
        `        </properties>\n` +
        `        <properties context='extract'>\n` +
        `          <relation name='${n}' table='[Extract].[${n}]' type='table' />\n` +
        `        </properties>\n` +
        `      </object>\n`
      );
    })
    .join('');

  const relsXml = relationships
    .map((r) => {
      const card: SalesforceCardinality = r.cardinality ?? 'many-to-many';
      const leftUnique = card === 'one-to-many' || card === 'one-to-one';
      const rightUnique = card === 'many-to-one' || card === 'one-to-one';
      const leftAlias = escapeXml(aliasFor(r.leftObject, r.leftField));
      const rightAlias = escapeXml(aliasFor(r.rightObject, r.rightField));
      const leftId = escapeXml(bareId(r.leftObject));
      const rightId = escapeXml(bareId(r.rightObject));
      const head = (u: boolean) => (u ? `is-db-set-unique-key='true' ` : '');
      const tail = (u: boolean) => (u ? ` unique-key='true'` : '');
      return (
        `      <relationship>\n` +
        `        <expression op='='>\n` +
        `          <expression op='[${leftAlias}]' />\n` +
        `          <expression op='[${rightAlias}]' />\n` +
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

/** A datasource-level `<column>` named by a unique alias (multi-object variant). */
function columnElementAliased(field: SalesforceColumnSpec, alias: string): string {
  const twb = salesforceToTwbDataType(field.salesforceType);
  const role = twb === 'integer' || twb === 'real' ? 'measure' : 'dimension';
  const type = role === 'measure' ? 'quantitative' : twb === 'date' || twb === 'datetime' ? 'ordinal' : 'nominal';
  return `<column datatype='${twb}' name='[${escapeXml(alias)}]' role='${role}' type='${type}' />`;
}

/** `<cols>` alias map (`[Field]` -> `[Object].[Field]`) for the given fields, or '' if none. */
function colsMapXml(fields: SalesforceColumnSpec[], objName: string, indent = '    '): string {
  if (fields.length === 0) return '';
  const inner = indent + '  ';
  return (
    `${indent}<cols>\n` +
    fields.map((f) => `${inner}<map key='[${escapeXml(f.name)}]' value='[${objName}].[${escapeXml(f.name)}]' />\n`).join('') +
    `${indent}</cols>\n`
  );
}

/** `<metadata-records>` block (one record per field) for the given fields, or '' if none. */
function metadataRecordsXml(
  fields: SalesforceColumnSpec[],
  object: string,
  objectId: string,
  indent = '    ',
): string {
  if (fields.length === 0) return '';
  return (
    `${indent}<metadata-records>\n` +
    fields.map((f) => metadataRecord(f, object, objectId, indent + '  ')).join('') +
    `${indent}</metadata-records>\n`
  );
}

/**
 * `<extract enabled='true'>` element with a `class='hyper'` connection pointing at the
 * `.hyper` bundled in the `.tdsx`. The extract table lives in schema `Extract` and is
 * named after the object; its columns mirror the live schema (same field set/types).
 */
function extractElementXml(
  fields: SalesforceColumnSpec[],
  object: string,
  objName: string,
  objectId: string,
  hyperDbname: string,
): string {
  // The <extract> attribute uses the bare object id (no surrounding brackets), while
  // <metadata-record>/<object-id> keep the bracketed form.
  const bareObjectId = objectId.replace(/^\[|\]$/g, '');
  return (
    `  <extract count='-1' enabled='true' object-id='${escapeXml(bareObjectId)}' units='records' user-specific='false'>\n` +
    `    <connection authentication='auth-none' class='hyper' dbname='${escapeXml(hyperDbname)}' ` +
    `default-settings='yes' schema='Extract' tablename='Extract'>\n` +
    `      <relation name='${objName}' table='[Extract].[${objName}]' type='table' />\n` +
    colsMapXml(fields, objName, '      ') +
    metadataRecordsXml(fields, object, objectId, '      ') +
    `    </connection>\n` +
    `  </extract>\n`
  );
}

/**
 * Tableau OLE-DB remote-type code for a Tableau local datatype, matching the values
 * observed in the reference datasource's `<metadata-record>`s.
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
      return 130; // Unicode string (DBTYPE_WSTR)
  }
}

/** Default aggregation for a column: Sum for numeric measures, Count otherwise (per reference). */
function aggregationFor(twb: TwbType): string {
  return twb === 'integer' || twb === 'real' ? 'Sum' : 'Count';
}

/**
 * Stable per-object id used by `<metadata-record>` / `<extract>`: `[Object (Object)_<HASH>]`.
 * The reference uses a 32-hex-uppercase suffix; we derive it deterministically from the
 * object name so regenerating the same object yields the same id.
 */
export function salesforceObjectId(object: string): string {
  const hash = createHash('md5').update(object).digest('hex').toUpperCase();
  return `[${object} (${object})_${hash}]`;
}

/** A single `<metadata-record class='column'>` for a described field. */
function metadataRecord(
  field: SalesforceColumnSpec,
  object: string,
  objectId: string,
  indent = '      ',
  localName?: string,
): string {
  const twb = salesforceToTwbDataType(field.salesforceType);
  const name = escapeXml(field.name);
  const remoteType = localTypeToRemoteCode(twb);
  const containsNull = field.nillable === false ? 'false' : 'true';
  const inner = indent + '  ';
  // `local-name` is the field's GLOBAL identity/caption. In a multi-object datasource the
  // same API name (e.g. `Id`) exists on several objects, so callers pass a unique alias
  // (`Object.Field`) to avoid Tableau's "Duplicate field name" load error. `remote-name`/
  // `remote-alias` always keep the raw Salesforce API name (scoped by parent-name).
  const local = escapeXml(localName ?? field.name);
  return (
    `${indent}<metadata-record class='column'>\n` +
    `${inner}<remote-name>${name}</remote-name>\n` +
    `${inner}<remote-type>${remoteType}</remote-type>\n` +
    `${inner}<local-name>[${local}]</local-name>\n` +
    `${inner}<parent-name>[${escapeXml(object)}]</parent-name>\n` +
    `${inner}<remote-alias>${name}</remote-alias>\n` +
    `${inner}<local-type>${twb}</local-type>\n` +
    `${inner}<aggregation>${aggregationFor(twb)}</aggregation>\n` +
    `${inner}<contains-null>${containsNull}</contains-null>\n` +
    `${inner}<object-id>${escapeXml(objectId)}</object-id>\n` +
    `${indent}</metadata-record>\n`
  );
}

/** A single datasource-level `<column>` element for a described Salesforce field. */
function columnElement(field: SalesforceColumnSpec): string {
  const twb = salesforceToTwbDataType(field.salesforceType);
  const role = twb === 'integer' || twb === 'real' ? 'measure' : 'dimension';
  const type = role === 'measure' ? 'quantitative' : twb === 'date' || twb === 'datetime' ? 'ordinal' : 'nominal';
  const name = escapeXml(field.name);
  return `<column datatype='${twb}' name='[${name}]' role='${role}' type='${type}' />`;
}
