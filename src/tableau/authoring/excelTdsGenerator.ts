/**
 * Deterministic Tableau datasource (`.tds`) generator for the Excel connector.
 *
 * Mirrors the EXTRACT-backed structure of the Salesforce generators (`tdsGenerator.ts`)
 * so we never ask the LLM to author XML. The ONLY differences from the Salesforce
 * relationships/join output are connector-specific and captured here:
 *   1. the `<named-connection>` wraps a `class='excel-direct'` connection with a `filename`
 *      (vs `class='salesforce'` OAuth), reconciled against
 *      `reference/sample ds Excel Connector.tds`;
 *   2. the physical `<relation>`s reference that connection and an Excel sheet range
 *      (`table='[<sheet>$]'`) instead of a Salesforce object (`table='[<object>]'`).
 *
 * Everything else — the `<document-format-change-manifest>`, the merged `<cols>` /
 * `<metadata-records>`, the datasource-level `<column>` list, the `<extract class='hyper'>`
 * element over `Extract."<sheet>"` tables, and the trailing `<object-graph>` — reuses the
 * connection-agnostic helpers exported from `tdsGenerator.ts`, so the two connectors stay
 * in lock-step. Published Excel datasources are EXTRACT-ONLY: the bundled `.hyper` holds the
 * data and the `excel-direct` connection is retained only for schema/lineage (the local
 * file is never read on Tableau Cloud).
 */
import { escapeXml } from './xml.js';
import type { ExcelColumnType } from '../../excel/excelClient.js';
import {
  documentFormatChangeManifestXml,
  colsMapMultiXml,
  metadataRecordsMultiXml,
  columnsMultiXml,
  extractElementMultiXml,
  extractElementWithRelationXml,
  colsMapXml,
  metadataRecordsXml,
  columnElement,
  extractElementXml,
  salesforceObjectId,
  type SalesforceTableSpec,
  type SalesforceColumnSpec,
  type SalesforceRelationshipSpec,
  type SalesforceCardinality,
  type SalesforceJoinType,
  type HyperColumnType,
} from './tdsGenerator.js';

/** Stable internal named-connection id for generated Excel datasources. */
const EXCEL_CONNECTION_NAME = 'excel-direct.tableaupilot';

/** One Excel column: identifier-safe name + inferred type. */
export interface ExcelColumnSpec {
  /** Identifier-safe field name (`[A-Za-z][A-Za-z0-9_]*`). */
  name: string;
  /** Inferred Excel column type. */
  type: ExcelColumnType;
  /** Whether the column may be null (maps to `contains-null`). Defaults to true. */
  nillable?: boolean;
}

/** One worksheet participating in a datasource. */
export interface ExcelSheetSpec {
  /** Identifier-safe sheet id — the physical relation name AND the `Extract."<id>"` table. */
  sheet: string;
  /** Original worksheet name shown as the object caption (defaults to `sheet`). */
  caption?: string;
  /** The sheet's columns. */
  columns: ExcelColumnSpec[];
}

export interface ExcelTdsInput {
  datasourceName: string;
  /** Uploaded workbook file name (basename) for the `excel-direct` `filename`/caption. */
  filename: string;
  /** The single sheet's identifier-safe id. */
  sheet: string;
  /** Original worksheet name (caption). */
  caption?: string;
  columns: ExcelColumnSpec[];
  extract: { hyperDbname: string };
}

export interface ExcelRelationshipsTdsInput {
  datasourceName: string;
  filename: string;
  /** The worksheets to combine (>= 2). */
  tables: ExcelSheetSpec[];
  /** The relationships connecting the sheets into one graph. */
  relationships: SalesforceRelationshipSpec[];
  extract: { hyperDbname: string };
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Map an inferred Excel type to the synthetic Salesforce type token reused by the helpers. */
function excelTypeToSalesforceToken(type: ExcelColumnType): string {
  switch (type) {
    case 'integer':
      return 'int';
    case 'real':
      return 'double';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    default:
      return 'string';
  }
}

/** Map an inferred Excel type to the Hyper extract column category (for the `.hyper` schema). */
export function excelToHyperType(type: ExcelColumnType): HyperColumnType {
  switch (type) {
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

/** Adapt Excel columns to the Salesforce column spec the shared helpers consume. */
function toFields(columns: ExcelColumnSpec[]): SalesforceColumnSpec[] {
  return (columns ?? []).map((c) => ({
    name: c.name,
    salesforceType: excelTypeToSalesforceToken(c.type),
    nillable: c.nillable,
  }));
}

/** Adapt an Excel sheet to the Salesforce table spec (object == identifier-safe sheet id). */
function toTableSpec(t: ExcelSheetSpec): SalesforceTableSpec {
  return { object: t.sheet, fields: toFields(t.columns) };
}

function validateSheetId(sheet: string): void {
  if (!IDENT.test(String(sheet ?? '').trim())) {
    throw new Error(`Invalid Excel sheet id for datasource generation: ${sheet}`);
  }
}

/** The `excel-direct` named-connection block (live source, used for schema/lineage only). */
function excelNamedConnectionXml(filename: string): string {
  const f = escapeXml(filename || 'workbook.xlsx');
  return (
    `    <named-connections>\n` +
    `      <named-connection caption='${f}' name='${EXCEL_CONNECTION_NAME}'>\n` +
    `        <connection class='excel-direct' cleaning='no' compat='no' dataRefreshTime='' ` +
    `filename='${f}' interpretationMode='0' password='' server='' validate='no' />\n` +
    `      </named-connection>\n` +
    `    </named-connections>\n`
  );
}

/** One physical `<relation>` per sheet (relationships model), inside a `<relation type='collection'>`. */
function excelRelationCollectionXml(tables: ExcelSheetSpec[], indent = '    '): string {
  const inner = indent + '  ';
  const rels = tables
    .map((t) => {
      const id = escapeXml(t.sheet);
      return `${inner}<relation connection='${EXCEL_CONNECTION_NAME}' name='${id}' table='[${id}$]' type='table' />\n`;
    })
    .join('');
  return `${indent}<relation type='collection'>\n` + rels + `${indent}</relation>\n`;
}

/** Physical/extract left-deep `<relation type='join'>` tree (physical-join model). */
function excelJoinTreeXml(
  tables: ExcelSheetSpec[],
  relationships: SalesforceRelationshipSpec[],
  opts: { live: boolean },
  indent = '    ',
): string {
  const relByRight = new Map(relationships.map((r) => [r.rightObject, r]));
  const leaf = (sheet: string, ind: string): string => {
    const id = escapeXml(sheet);
    return opts.live
      ? `${ind}<relation connection='${EXCEL_CONNECTION_NAME}' name='${id}' table='[${id}$]' type='table' />\n`
      : `${ind}<relation name='${id}' table='[Extract].[${id}]' type='table' />\n`;
  };
  const buildNode = (k: number, ind: string): string => {
    const sheet = String(tables[k]?.sheet ?? '');
    if (k === 0) return leaf(sheet, ind);
    const rel = relByRight.get(sheet);
    const joinType: SalesforceJoinType = rel?.joinType ?? 'left';
    const inner = ind + '  ';
    return (
      `${ind}<relation join='${joinType}' type='join'>\n` +
      buildNode(k - 1, inner) +
      leaf(sheet, inner) +
      excelJoinClauseXml(rel, inner) +
      `${ind}</relation>\n`
    );
  };
  return buildNode(tables.length - 1, indent);
}

/** `<clause type='join'>` with an `=` expression over the two physical `[sheet].[field]` columns. */
function excelJoinClauseXml(rel: SalesforceRelationshipSpec | undefined, indent: string): string {
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

/** The trailing `<object-graph>`: sheets as objects + relationships with cardinality. */
function excelObjectGraphXml(tables: ExcelSheetSpec[], relationships: SalesforceRelationshipSpec[]): string {
  const bareId = (sheet: string): string => salesforceObjectId(sheet).replace(/^\[|\]$/g, '');
  const alias = (sheet: string, field: string): string => `${sheet}.${field}`;

  const objectsXml = tables
    .map((t) => {
      const id = escapeXml(t.sheet);
      const caption = escapeXml(t.caption ?? t.sheet);
      const oid = escapeXml(bareId(t.sheet));
      return (
        `      <object caption='${caption}' id='${oid}'>\n` +
        `        <properties context=''>\n` +
        `          <relation connection='${EXCEL_CONNECTION_NAME}' name='${id}' table='[${id}$]' type='table' />\n` +
        `        </properties>\n` +
        `        <properties context='extract'>\n` +
        `          <relation name='${id}' table='[Extract].[${id}]' type='table' />\n` +
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
      const leftAlias = escapeXml(alias(r.leftObject, r.leftField));
      const rightAlias = escapeXml(alias(r.rightObject, r.rightField));
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

/**
 * Generate a `.tds` for a single-sheet, EXTRACT-backed Excel datasource. Mirrors
 * `generateSalesforceTds` but with the `excel-direct` connection and a `[<sheet>$]` relation.
 */
export function generateExcelTds(input: ExcelTdsInput): string {
  const sheet = String(input.sheet ?? '').trim();
  validateSheetId(sheet);
  const fields = toFields(input.columns);
  const objName = escapeXml(sheet);
  const objectId = salesforceObjectId(sheet);
  const formattedName = escapeXml(input.datasourceName || input.caption || sheet);

  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${formattedName}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n` +
    documentFormatChangeManifestXml() +
    `  <connection class='federated'>\n` +
    excelNamedConnectionXml(input.filename) +
    `    <relation connection='${EXCEL_CONNECTION_NAME}' name='${objName}' table='[${objName}$]' type='table' />\n` +
    colsMapXml(fields, objName) +
    metadataRecordsXml(fields, sheet, objectId) +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    fields.map((f) => `  ${columnElement(f)}\n`).join('') +
    extractElementXml(fields, sheet, objName, objectId, input.extract.hyperDbname) +
    `</datasource>\n`
  );
}

/**
 * Generate a `.tds` for a multi-sheet, EXTRACT-backed Excel datasource using Tableau's
 * relationships (object-graph) model. Mirrors `generateSalesforceRelationshipsTds`.
 */
export function generateExcelRelationshipsTds(input: ExcelRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) {
    throw new Error('generateExcelRelationshipsTds requires at least two sheets.');
  }
  tables.forEach((t) => validateSheetId(t.sheet));
  const specs = tables.map(toTableSpec);
  const formattedName = escapeXml(input.datasourceName || tables[0]?.caption || tables[0]?.sheet || '');

  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${formattedName}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n` +
    documentFormatChangeManifestXml(true) +
    `  <connection class='federated'>\n` +
    excelNamedConnectionXml(input.filename) +
    excelRelationCollectionXml(tables) +
    colsMapMultiXml(specs) +
    metadataRecordsMultiXml(specs, '    ') +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsMultiXml(specs) +
    extractElementMultiXml(specs, input.extract.hyperDbname) +
    excelObjectGraphXml(tables, input.relationships ?? []) +
    `</datasource>\n`
  );
}

/**
 * Generate a `.tds` for a multi-sheet, EXTRACT-backed Excel datasource using a PHYSICAL
 * join (`<relation type='join'>`). Mirrors `generateSalesforcePhysicalJoinTds`.
 */
export function generateExcelPhysicalJoinTds(input: ExcelRelationshipsTdsInput): string {
  const tables = input.tables ?? [];
  if (tables.length < 2) {
    throw new Error('generateExcelPhysicalJoinTds requires at least two sheets.');
  }
  tables.forEach((t) => validateSheetId(t.sheet));
  const specs = tables.map(toTableSpec);
  const relationships = input.relationships ?? [];
  const formattedName = escapeXml(input.datasourceName || tables[0]?.caption || tables[0]?.sheet || '');

  return (
    `<?xml version='1.0' encoding='utf-8' ?>\n` +
    `<datasource formatted-name='${formattedName}' inline='true' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>\n` +
    documentFormatChangeManifestXml() +
    `  <connection class='federated'>\n` +
    excelNamedConnectionXml(input.filename) +
    excelJoinTreeXml(tables, relationships, { live: true }) +
    colsMapMultiXml(specs) +
    metadataRecordsMultiXml(specs, '    ') +
    `  </connection>\n` +
    `  <aliases enabled='yes' />\n` +
    columnsMultiXml(specs) +
    extractElementWithRelationXml(
      specs,
      input.extract.hyperDbname,
      excelJoinTreeXml(tables, relationships, { live: false }, '      '),
    ) +
    `</datasource>\n`
  );
}
