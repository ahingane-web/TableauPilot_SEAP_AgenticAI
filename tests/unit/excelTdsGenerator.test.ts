import { describe, it, expect } from 'vitest';
import {
  generateExcelTds,
  generateExcelRelationshipsTds,
  generateExcelPhysicalJoinTds,
  excelToHyperType,
} from '../../src/tableau/authoring/excelTdsGenerator.js';

const ORDERS = {
  sheet: 'Orders',
  caption: 'Orders',
  columns: [
    { name: 'Order_ID', type: 'string' as const },
    { name: 'Customer_ID', type: 'string' as const },
    { name: 'Sales', type: 'real' as const },
    { name: 'Quantity', type: 'integer' as const },
    { name: 'Order_Date', type: 'date' as const },
  ],
};
const CUSTOMERS = {
  sheet: 'Customers',
  caption: 'Customers',
  columns: [
    { name: 'Customer_ID', type: 'string' as const },
    { name: 'Segment', type: 'string' as const },
  ],
};

describe('excelToHyperType', () => {
  it('maps inferred Excel types to Hyper column categories', () => {
    expect(excelToHyperType('integer')).toBe('int');
    expect(excelToHyperType('real')).toBe('double');
    expect(excelToHyperType('boolean')).toBe('bool');
    expect(excelToHyperType('date')).toBe('date');
    expect(excelToHyperType('datetime')).toBe('timestamp');
    expect(excelToHyperType('string')).toBe('text');
  });
});

describe('generateExcelTds (single sheet)', () => {
  const tds = generateExcelTds({
    datasourceName: 'APAC Superstore DS',
    filename: 'Sample - APAC Superstore.xlsx',
    sheet: ORDERS.sheet,
    caption: ORDERS.caption,
    columns: ORDERS.columns,
    extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
  });

  it('produces a well-formed .tds root', () => {
    expect(tds.startsWith("<?xml version='1.0'")).toBe(true);
    expect(tds).toContain('<datasource ');
    expect(tds).toContain('</datasource>');
  });

  it('emits the object-model manifest before the connection', () => {
    expect(tds).toContain('<document-format-change-manifest>');
    expect(tds).toContain('<ObjectModelExtractV2 />');
    expect(tds.indexOf('<document-format-change-manifest>')).toBeLessThan(tds.indexOf("<connection class='federated'>"));
  });

  it('uses an excel-direct named-connection with the uploaded filename (not Salesforce)', () => {
    expect(tds).toContain("class='excel-direct'");
    expect(tds).toContain("filename='Sample - APAC Superstore.xlsx'");
    expect(tds).not.toContain("class='salesforce'");
  });

  it('references the sheet range and an extract-backed hyper connection', () => {
    expect(tds).toContain("table='[Orders$]'");
    expect(tds).toContain("<extract count='-1' enabled='true'");
    expect(tds).toContain("class='hyper'");
    expect(tds).toContain("table='[Extract].[Orders]'");
    expect(tds).toContain("dbname='Data/Extracts/federated_abc.hyper'");
  });

  it('emits datasource columns with correct roles', () => {
    expect(tds).toContain("<column datatype='real' name='[Sales]' role='measure'");
    expect(tds).toContain("<column datatype='integer' name='[Quantity]' role='measure'");
    expect(tds).toContain("<column datatype='string' name='[Order_ID]' role='dimension'");
    expect(tds).toContain("<column datatype='date' name='[Order_Date]' role='dimension'");
  });
});

describe('generateExcelRelationshipsTds (multi-sheet, relationships)', () => {
  const tds = generateExcelRelationshipsTds({
    datasourceName: 'Orders + Customers',
    filename: 'workbook.xlsx',
    tables: [ORDERS, CUSTOMERS],
    relationships: [
      {
        leftObject: 'Orders',
        leftField: 'Customer_ID',
        rightObject: 'Customers',
        rightField: 'Customer_ID',
        cardinality: 'many-to-one',
        joinType: 'left',
      },
    ],
    extract: { hyperDbname: 'Data/Extracts/federated_rel.hyper' },
  });

  it('carries the relationships perf flag and an object-graph', () => {
    expect(tds).toContain('<ObjectModelRelationshipPerfOptions />');
    expect(tds).toContain('<object-graph>');
    expect(tds).toContain('<relationship>');
  });

  it('emits one excel-direct relation per sheet inside a collection', () => {
    expect(tds).toContain("<relation type='collection'>");
    expect(tds).toContain("<relation connection='excel-direct.tableaupilot' name='Orders' table='[Orders$]' type='table' />");
    expect(tds).toContain("<relation connection='excel-direct.tableaupilot' name='Customers' table='[Customers$]' type='table' />");
  });

  it('creates one Extract table per sheet', () => {
    expect(tds).toContain("table='[Extract].[Orders]'");
    expect(tds).toContain("table='[Extract].[Customers]'");
  });

  it('qualifies field aliases as SheetId.Field to avoid collisions', () => {
    // Customer_ID exists on BOTH sheets — aliases must be qualified.
    expect(tds).toContain("[Orders.Customer_ID]");
    expect(tds).toContain("[Customers.Customer_ID]");
  });

  it('encodes the relationship cardinality on the object-graph end-points', () => {
    // many-to-one => the RIGHT side (Customers) is the unique key.
    expect(tds).toContain("unique-key='true'");
    expect(tds).toContain("<expression op='[Orders.Customer_ID]' />");
    expect(tds).toContain("<expression op='[Customers.Customer_ID]' />");
  });

  it('throws when fewer than two sheets are provided', () => {
    expect(() =>
      generateExcelRelationshipsTds({
        datasourceName: 'x',
        filename: 'w.xlsx',
        tables: [ORDERS],
        relationships: [],
        extract: { hyperDbname: 'Data/Extracts/x.hyper' },
      }),
    ).toThrow(/at least two sheets/);
  });
});

describe('generateExcelPhysicalJoinTds (multi-sheet, physical join)', () => {
  const tds = generateExcelPhysicalJoinTds({
    datasourceName: 'Orders JOIN Customers',
    filename: 'workbook.xlsx',
    tables: [ORDERS, CUSTOMERS],
    relationships: [
      {
        leftObject: 'Orders',
        leftField: 'Customer_ID',
        rightObject: 'Customers',
        rightField: 'Customer_ID',
        cardinality: 'many-to-one',
        joinType: 'inner',
      },
    ],
    extract: { hyperDbname: 'Data/Extracts/federated_join.hyper' },
  });

  it('emits a physical join relation with the chosen join type and NO object-graph', () => {
    expect(tds).toContain("<relation join='inner' type='join'>");
    expect(tds).toContain("<clause type='join'>");
    expect(tds).toContain("<expression op='[Orders].[Customer_ID]' />");
    expect(tds).toContain("<expression op='[Customers].[Customer_ID]' />");
    expect(tds).not.toContain('<object-graph>');
  });

  it('joins over both live and extract relations', () => {
    expect(tds).toContain("<relation connection='excel-direct.tableaupilot' name='Orders' table='[Orders$]' type='table' />");
    expect(tds).toContain("table='[Extract].[Customers]'");
  });
});
