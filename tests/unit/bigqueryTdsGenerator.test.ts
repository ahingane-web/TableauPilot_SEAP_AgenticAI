import { describe, it, expect } from 'vitest';
import {
  generateBigQueryTds,
  generateBigQueryRelationshipsTds,
  generateBigQueryPhysicalJoinTds,
  bigQueryObjectId,
  bigQueryToHyperType,
  bigQueryFieldIdentities,
  type BigQueryConnectionInfo,
} from '../../src/tableau/authoring/bigqueryTdsGenerator.js';

const conn: BigQueryConnectionInfo = {
  billingProjectId: 'tableauagent-510111',
  dataProjectId: 'tableauagent-510111',
  dataProjectName: 'TableauAgent',
  datasetId: 'TableauAgentDataset',
  username: 'akashhingane2121@gmail.com',
};

const ordersColumns = [
  { name: 'Row ID', bqType: 'INT64' },
  { name: 'Order ID', bqType: 'STRING' },
  { name: 'Order Date', bqType: 'DATE' },
  { name: 'Sales', bqType: 'FLOAT64' },
  { name: 'Sub-Category', bqType: 'STRING' },
  { name: 'Region', bqType: 'STRING' },
];

const peopleColumns = [
  { name: 'Regional Manager', bqType: 'STRING' },
  { name: 'Region', bqType: 'STRING' },
];

describe('bigQueryToHyperType', () => {
  it('maps BigQuery standard-SQL types to Hyper column categories', () => {
    expect(bigQueryToHyperType('INT64')).toBe('int');
    expect(bigQueryToHyperType('INTEGER')).toBe('int');
    expect(bigQueryToHyperType('FLOAT64')).toBe('double');
    expect(bigQueryToHyperType('NUMERIC')).toBe('double');
    expect(bigQueryToHyperType('BOOL')).toBe('bool');
    expect(bigQueryToHyperType('DATE')).toBe('date');
    expect(bigQueryToHyperType('TIMESTAMP')).toBe('timestamp');
    expect(bigQueryToHyperType('DATETIME')).toBe('timestamp');
    expect(bigQueryToHyperType('STRING')).toBe('text');
    expect(bigQueryToHyperType('GEOGRAPHY')).toBe('text');
  });
});

describe('bigQueryObjectId', () => {
  it('is identifier-safe and deterministic', () => {
    const a = bigQueryObjectId('Orders');
    const b = bigQueryObjectId('Orders');
    expect(a).toBe(b);
    expect(a).toMatch(/^Orders_[0-9A-F]{32}$/);
  });

  it('sanitizes table names with spaces/hyphens into a valid identifier prefix', () => {
    const id = bigQueryObjectId('Order Data-2024');
    expect(id).toMatch(/^Order_Data_2024_[0-9A-F]{32}$/);
  });
});

describe('generateBigQueryTds (single table, live)', () => {
  const tds = generateBigQueryTds({
    datasourceName: 'BigQuery Orders DS',
    connection: conn,
    materialization: 'live',
    table: 'Orders',
    columns: ordersColumns,
  });

  it('produces a well-formed .tds root', () => {
    expect(tds.startsWith("<?xml version='1.0'")).toBe(true);
    expect(tds).toContain('<datasource ');
    expect(tds).toContain('</datasource>');
  });

  it('mirrors the reference BigQuery OAuth connection block', () => {
    expect(tds).toContain("<connection class='federated'>");
    expect(tds).toContain("class='bigquery'");
    expect(tds).toContain("authentication='oauth'");
    expect(tds).toContain("connection-dialect='google-sql'");
    expect(tds).toContain("server-oauth=''");
    expect(tds).toContain("CATALOG='tableauagent-510111'");
    expect(tds).toContain("EXECCATALOG='tableauagent-510111'");
    expect(tds).toContain("project='TableauAgent'");
    expect(tds).toContain("schema='TableauAgentDataset'");
    expect(tds).toContain("username='akashhingane2121@gmail.com'");
  });

  it('references the table as [project.dataset].[table]', () => {
    expect(tds).toContain("table='[tableauagent-510111.TableauAgentDataset].[Orders]'");
  });

  it('keeps REAL BigQuery column names (with spaces/hyphens) as remote-name/local-name', () => {
    expect(tds).toContain('<remote-name>Order Date</remote-name>');
    expect(tds).toContain('<local-name>[Order Date]</local-name>');
    expect(tds).toContain('<remote-name>Sub-Category</remote-name>');
    expect(tds).toContain('<local-name>[Sub-Category]</local-name>');
    expect(tds).toContain("<map key='[Order Date]' value='[Orders].[Order Date]' />");
  });

  it('is a LIVE datasource: no <extract>, manifest omits ObjectModelExtractV2', () => {
    expect(tds).not.toContain('<extract ');
    expect(tds).not.toContain('<ObjectModelExtractV2 />');
    expect(tds).not.toContain("context='extract'");
    // The live object-graph still maps the single object with context=''.
    expect(tds).toContain('<object-graph>');
    expect(tds).toContain("<properties context=''>");
  });
});

describe('generateBigQueryTds (single table, extract)', () => {
  const tds = generateBigQueryTds({
    datasourceName: 'BigQuery Orders Extract',
    connection: conn,
    materialization: 'extract',
    table: 'Orders',
    columns: ordersColumns,
    extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
  });

  it('emits an <extract class="hyper"> over Extract."<objectId>" and the ExtractV2 manifest', () => {
    expect(tds).toContain('<ObjectModelExtractV2 />');
    expect(tds).toContain("class='hyper'");
    expect(tds).toContain("dbname='Data/Extracts/federated_abc.hyper'");
    const oid = bigQueryObjectId('Orders');
    expect(tds).toContain(`table='[Extract].[${oid}]'`);
    // The extract's object-graph carries both live and extract contexts.
    expect(tds).toContain("context='extract'");
    expect(tds).toContain("<properties context=''>");
  });

  it('throws when an extract is requested without a hyperDbname', () => {
    expect(() =>
      generateBigQueryTds({
        datasourceName: 'x',
        connection: conn,
        materialization: 'extract',
        table: 'Orders',
        columns: ordersColumns,
      }),
    ).toThrow();
  });
});

describe('generateBigQueryRelationshipsTds (multi-table)', () => {
  const tds = generateBigQueryRelationshipsTds({
    datasourceName: 'Orders + People',
    connection: conn,
    materialization: 'extract',
    tables: [
      { table: 'Orders', columns: ordersColumns },
      { table: 'People', columns: peopleColumns },
    ],
    relationships: [
      {
        leftTable: 'Orders',
        leftField: 'Region',
        rightTable: 'People',
        rightField: 'Region',
        cardinality: 'many-to-one',
      },
    ],
    extract: { hyperDbname: 'Data/Extracts/federated_x.hyper' },
  });

  it('disambiguates a duplicate column name across tables (Region -> Region (People))', () => {
    expect(tds).toContain('<local-name>[Region]</local-name>');
    expect(tds).toContain('<local-name>[Region (People)]</local-name>');
    // The People.Region cols map value keeps the REAL field name, scoped by its table.
    expect(tds).toContain("<map key='[Region (People)]' value='[People].[Region]' />");
  });

  it('emits the relationships perf flag and one relationship in the object-graph', () => {
    expect(tds).toContain('<ObjectModelRelationshipPerfOptions />');
    const ordersId = bigQueryObjectId('Orders');
    const peopleId = bigQueryObjectId('People');
    expect(tds).toContain(`object-id='${ordersId}'`);
    expect(tds).toContain(`object-id='${peopleId}'`);
    // many-to-one => the right (People) side is the unique key.
    expect(tds).toContain(`<second-end-point is-db-set-unique-key='true' object-id='${peopleId}' unique-key='true' />`);
    // Relationship expression references the disambiguated local names.
    expect(tds).toContain("<expression op='[Region]' />");
    expect(tds).toContain("<expression op='[Region (People)]' />");
  });

  it('has a <relation type="collection"> in the federated connection', () => {
    expect(tds).toContain("<relation type='collection'>");
    expect(tds).toContain("table='[tableauagent-510111.TableauAgentDataset].[Orders]'");
    expect(tds).toContain("table='[tableauagent-510111.TableauAgentDataset].[People]'");
  });
});

describe('generateBigQueryPhysicalJoinTds (multi-table)', () => {
  const tds = generateBigQueryPhysicalJoinTds({
    datasourceName: 'Orders JOIN People',
    connection: conn,
    materialization: 'live',
    tables: [
      { table: 'Orders', columns: ordersColumns },
      { table: 'People', columns: peopleColumns },
    ],
    relationships: [
      { leftTable: 'Orders', leftField: 'Region', rightTable: 'People', rightField: 'Region', joinType: 'inner' },
    ],
    extract: undefined,
  });

  it('emits a physical <relation type="join"> tree with NO object-graph', () => {
    expect(tds).toContain("<relation join='inner' type='join'>");
    expect(tds).toContain("<clause type='join'>");
    expect(tds).toContain("<expression op='[Orders].[Region]' />");
    expect(tds).toContain("<expression op='[People].[Region]' />");
    expect(tds).not.toContain('<object-graph>');
    expect(tds).not.toContain('<extract ');
  });
});

describe('bigQueryFieldIdentities', () => {
  it('returns disambiguated local names + datatypes matching the generated .tds', () => {
    const ids = bigQueryFieldIdentities([
      { table: 'Orders', columns: ordersColumns },
      { table: 'People', columns: peopleColumns },
    ]);
    const byLocal = Object.fromEntries(ids.map((i) => [i.local, i]));
    expect(byLocal['Order Date']!.twb).toBe('date');
    expect(byLocal['Sales']!.twb).toBe('real');
    expect(byLocal['Row ID']!.twb).toBe('integer');
    expect(byLocal['Region']).toBeTruthy();
    expect(byLocal['Region (People)']).toBeTruthy();
  });
});
