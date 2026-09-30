import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  generateSnowflakeTds,
  generateSnowflakeRelationshipsTds,
  generateSnowflakePhysicalJoinTds,
  snowflakeObjectId,
  snowflakeToHyperType,
  snowflakeFieldIdentities,
  type SnowflakeConnectionInfo,
} from '../../src/tableau/authoring/snowflakeTdsGenerator.js';

const conn: SnowflakeConnectionInfo = {
  server: 'xy12345.snowflakecomputing.com',
  database: 'TABLEAUAGENT',
  schema: 'PUBLIC',
  warehouse: 'COMPUTE_WH',
  username: 'JANE',
};

const ordersColumns = [
  { name: 'Row ID', sfType: 'NUMBER(38,0)' },
  { name: 'Order ID', sfType: 'VARCHAR' },
  { name: 'Order Date', sfType: 'DATE' },
  { name: 'Sales', sfType: 'NUMBER(18,2)' },
  { name: 'Region', sfType: 'VARCHAR' },
];

const peopleColumns = [
  { name: 'Region', sfType: 'VARCHAR' },
  { name: 'Regional Manager', sfType: 'VARCHAR' },
];

describe('snowflakeToHyperType', () => {
  it('maps Snowflake types to Hyper column categories', () => {
    expect(snowflakeToHyperType('NUMBER(38,0)')).toBe('int');
    expect(snowflakeToHyperType('NUMBER(18,2)')).toBe('double');
    expect(snowflakeToHyperType('BOOLEAN')).toBe('bool');
    expect(snowflakeToHyperType('DATE')).toBe('date');
    expect(snowflakeToHyperType('TIMESTAMP_NTZ')).toBe('timestamp');
    expect(snowflakeToHyperType('VARCHAR')).toBe('text');
  });
});

describe('snowflakeObjectId', () => {
  it('is {TABLE} ({DATABASE}.{TABLE})_{MD5(db.schema.table)}', () => {
    const id = snowflakeObjectId('TABLEAUAGENT', 'PUBLIC', 'ORDERS');
    const hash = createHash('md5').update('TABLEAUAGENT.PUBLIC.ORDERS').digest('hex').toUpperCase();
    expect(id).toBe(`ORDERS (TABLEAUAGENT.ORDERS)_${hash}`);
  });

  it('is deterministic', () => {
    expect(snowflakeObjectId('TABLEAUAGENT', 'PUBLIC', 'ORDERS')).toBe(
      snowflakeObjectId('TABLEAUAGENT', 'PUBLIC', 'ORDERS'),
    );
  });
});

describe('generateSnowflakeTds (single table, live)', () => {
  const tds = generateSnowflakeTds({
    datasourceName: 'Snowflake Orders DS',
    connection: conn,
    materialization: 'live',
    table: 'ORDERS',
    columns: ordersColumns,
  });

  it('produces a well-formed .tds root', () => {
    expect(tds.startsWith("<?xml version='1.0'")).toBe(true);
    expect(tds).toContain('<datasource ');
    expect(tds).toContain('</datasource>');
  });

  it('emits a snowflake Username Password connection matching the reference', () => {
    expect(tds).toContain("<connection class='federated'>");
    expect(tds).toContain("class='snowflake'");
    expect(tds).toContain("authentication='Username Password'");
    expect(tds).toContain("dbname='TABLEAUAGENT'");
    expect(tds).toContain("schema='PUBLIC'");
    expect(tds).toContain("server='xy12345.snowflakecomputing.com'");
    expect(tds).toContain("warehouse='COMPUTE_WH'");
    expect(tds).toContain("username='JANE'");
    expect(tds).toContain("service=''");
    expect(tds).toContain("temp-table-detection='optimized'");
    expect(tds).toContain("caption='xy12345.snowflakecomputing.com' name='snowflake.tableaupilot'");
    expect(tds).toContain("odbc-connect-string-extras=''");
    expect(tds).not.toContain("authentication='oauth'");
    expect(tds).not.toMatch(/password=/i);
  });

  it('uses 3-part [DATABASE].[SCHEMA].[TABLE] relations', () => {
    expect(tds).toContain("name='ORDERS' table='[TABLEAUAGENT].[PUBLIC].[ORDERS]'");
  });

  it('keeps REAL column names as remote-name and uses ODBC remote-types', () => {
    expect(tds).toContain('<remote-name>Row ID</remote-name>');
    expect(tds).toContain('<local-name>[Row ID]</local-name>');
    expect(tds).toContain('<remote-name>Order Date</remote-name>');
    expect(tds).toContain('<remote-type>131</remote-type>');
    expect(tds).toContain('<remote-type>129</remote-type>');
    expect(tds).toContain('<remote-type>7</remote-type>');
  });

  it('is a LIVE datasource: no extract, no ObjectModelExtractV2, object-graph context empty only', () => {
    expect(tds).not.toContain('<extract ');
    expect(tds).not.toContain('<ObjectModelExtractV2 />');
    expect(tds).not.toContain('VConnDownstreamExtractsWithWarnings');
    expect(tds).not.toContain("context='extract'");
    expect(tds).toContain('<object-graph>');
    expect(tds).toContain("<properties context=''>");
  });
});

describe('generateSnowflakeTds (single table, extract)', () => {
  const tds = generateSnowflakeTds({
    datasourceName: 'Snowflake Orders Extract',
    connection: conn,
    materialization: 'extract',
    table: 'ORDERS',
    columns: ordersColumns,
    extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
  });

  it('emits extract Hyper relations over Extract."<objectId>" plus extract manifest flags', () => {
    expect(tds).toContain('<ObjectModelExtractV2 />');
    expect(tds).toContain('VConnDownstreamExtractsWithWarnings');
    expect(tds).toContain("class='hyper'");
    expect(tds).toContain("dbname='Data/Extracts/federated_abc.hyper'");
    expect(tds).toContain("username=''");
    const oid = snowflakeObjectId('TABLEAUAGENT', 'PUBLIC', 'ORDERS');
    expect(tds).toContain(`object-id='${oid}'`);
    expect(tds).toContain(`table='[Extract].[${oid}]'`);
    expect(tds).toContain("context='extract'");
    expect(tds).toContain("<properties context=''>");
  });

  it('throws when an extract is requested without a hyperDbname', () => {
    expect(() =>
      generateSnowflakeTds({
        datasourceName: 'x',
        connection: conn,
        materialization: 'extract',
        table: 'ORDERS',
        columns: ordersColumns,
      }),
    ).toThrow();
  });
});

describe('generateSnowflakeRelationshipsTds (multi-table)', () => {
  const tds = generateSnowflakeRelationshipsTds({
    datasourceName: 'Orders People DS',
    connection: conn,
    materialization: 'extract',
    tables: [
      { table: 'ORDERS', columns: ordersColumns },
      { table: 'PEOPLE', columns: peopleColumns },
    ],
    relationships: [{ leftTable: 'ORDERS', leftField: 'Region', rightTable: 'PEOPLE', rightField: 'Region' }],
    extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
  });

  it('disambiguates colliding local-names with (TABLE)', () => {
    const identities = snowflakeFieldIdentities('TABLEAUAGENT', 'PUBLIC', [
      { table: 'ORDERS', columns: ordersColumns },
      { table: 'PEOPLE', columns: peopleColumns },
    ]);
    const regionLocals = identities.filter((i) => i.real === 'Region').map((i) => i.local);
    expect(regionLocals).toContain('Region');
    expect(regionLocals).toContain('Region (PEOPLE)');
    expect(tds).toContain('<local-name>[Region]</local-name>');
    expect(tds).toContain('<local-name>[Region (PEOPLE)]</local-name>');
    expect(tds).toContain('<remote-name>Region</remote-name>');
  });

  it('keeps object-id shape with database.table in parentheses', () => {
    const oid = snowflakeObjectId('TABLEAUAGENT', 'PUBLIC', 'PEOPLE');
    expect(oid).toContain('PEOPLE (TABLEAUAGENT.PEOPLE)_');
    expect(tds).toContain(`table='[Extract].[${oid}]'`);
  });

  it('still uses 3-part relations on the live connection', () => {
    expect(tds).toContain("table='[TABLEAUAGENT].[PUBLIC].[ORDERS]'");
    expect(tds).toContain("table='[TABLEAUAGENT].[PUBLIC].[PEOPLE]'");
  });
});

describe('generateSnowflakePhysicalJoinTds', () => {
  const tds = generateSnowflakePhysicalJoinTds({
    datasourceName: 'Joined Snowflake',
    connection: conn,
    materialization: 'live',
    tables: [
      { table: 'ORDERS', columns: ordersColumns },
      { table: 'PEOPLE', columns: peopleColumns },
    ],
    relationships: [
      { leftTable: 'ORDERS', leftField: 'Region', rightTable: 'PEOPLE', rightField: 'Region', joinType: 'left' },
    ],
  });

  it('emits a live join tree without an extract', () => {
    expect(tds).toContain("type='join'");
    expect(tds).not.toContain('<extract ');
    expect(tds).toContain("class='snowflake'");
  });
});
