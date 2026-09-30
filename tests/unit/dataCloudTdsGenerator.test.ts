import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  generateDataCloudTds,
  generateDataCloudRelationshipsTds,
  generateDataCloudPhysicalJoinTds,
  dataCloudObjectId,
  dataCloudToHyperType,
  dataCloudFieldIdentities,
  type DataCloudConnectionInfo,
} from '../../src/tableau/authoring/dataCloudTdsGenerator.js';

const conn: DataCloudConnectionInfo = {
  instanceUrl: 'https://org.my.salesforce.com',
  server: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.c360a.salesforce.com',
  username: 'jane.doe@example.com',
  dataSpace: 'default',
  tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pod: 'prod21',
};

const accountColumns = [
  { name: 'ssot__Id__c', dcType: 'STRING' },
  { name: 'ssot__Name__c', dcType: 'STRING' },
  { name: 'ssot__CreatedDate__c', dcType: 'DATETIME' },
];

const contactColumns = [
  { name: 'ssot__Id__c', dcType: 'STRING' },
  { name: 'ssot__AccountId__c', dcType: 'STRING' },
  { name: 'ssot__Name__c', dcType: 'STRING' },
];

describe('dataCloudToHyperType', () => {
  it('maps Data Cloud types to Hyper column categories', () => {
    expect(dataCloudToHyperType('INTEGER')).toBe('int');
    expect(dataCloudToHyperType('NUMBER')).toBe('double');
    expect(dataCloudToHyperType('BOOLEAN')).toBe('bool');
    expect(dataCloudToHyperType('DATE')).toBe('date');
    expect(dataCloudToHyperType('DATETIME')).toBe('timestamp');
    expect(dataCloudToHyperType('TIMESTAMP')).toBe('timestamp');
    expect(dataCloudToHyperType('STRING')).toBe('text');
  });
});

describe('dataCloudObjectId', () => {
  it('is {caption}_{MD5(apiName)} with spaces kept', () => {
    const id = dataCloudObjectId('Account Contact', 'ssot__AccountContact__dlm');
    const hash = createHash('md5').update('ssot__AccountContact__dlm').digest('hex').toUpperCase();
    expect(id).toBe(`Account Contact_${hash}`);
    expect(id).toMatch(/^Account Contact_[0-9A-F]{32}$/);
  });

  it('is deterministic', () => {
    expect(dataCloudObjectId('Account', 'ssot__Account__dlm')).toBe(dataCloudObjectId('Account', 'ssot__Account__dlm'));
  });
});

describe('generateDataCloudTds (single object, live)', () => {
  const tds = generateDataCloudTds({
    datasourceName: 'Data Cloud Account DS',
    connection: conn,
    materialization: 'live',
    object: 'ssot__Account__dlm',
    caption: 'Account',
    columns: accountColumns,
  });

  it('produces a well-formed .tds root', () => {
    expect(tds.startsWith("<?xml version='1.0'")).toBe(true);
    expect(tds).toContain('<datasource ');
    expect(tds).toContain('</datasource>');
  });

  it('emits a salesforce-genie OAuth connection matching the reference', () => {
    expect(tds).toContain("<connection class='federated'>");
    expect(tds).toContain("class='salesforce-genie'");
    expect(tds).toContain("authentication='oauth'");
    expect(tds).toContain("dbname='a360/prod21/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;default'");
    expect(tds).toContain("instanceurl='https://org.my.salesforce.com'");
    expect(tds).toContain("server='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.c360a.salesforce.com'");
    expect(tds).toContain("username='jane.doe@example.com'");
    expect(tds).toContain("warehouse='default'");
    expect(tds).toContain("server-oauth=''");
  });

  it('uses [public].[apiName] relations with the friendly caption as the relation name', () => {
    expect(tds).toContain("name='Account' table='[public].[ssot__Account__dlm]'");
  });

  it('keeps REAL field API names as remote-name', () => {
    expect(tds).toContain('<remote-name>ssot__Id__c</remote-name>');
    expect(tds).toContain('<local-name>[ssot__Id__c]</local-name>');
    expect(tds).toContain('<remote-name>ssot__CreatedDate__c</remote-name>');
  });

  it('is a LIVE datasource: no extract, no ObjectModelExtractV2, object-graph context empty only', () => {
    expect(tds).not.toContain('<extract ');
    expect(tds).not.toContain('<ObjectModelExtractV2 />');
    expect(tds).not.toContain('<VConnDownstreamExtractsWithWarnings />');
    expect(tds).not.toContain("context='extract'");
    expect(tds).toContain('<object-graph>');
    expect(tds).toContain("<properties context=''>");
  });
});

describe('generateDataCloudTds (single object, extract)', () => {
  const tds = generateDataCloudTds({
    datasourceName: 'Data Cloud Account Extract',
    connection: conn,
    materialization: 'extract',
    object: 'ssot__Account__dlm',
    caption: 'Account',
    columns: accountColumns,
    extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
  });

  it('emits extract Hyper relations over Extract."<objectId>" plus extract manifest flags', () => {
    expect(tds).toContain('<ObjectModelExtractV2 />');
    expect(tds).toContain('<VConnDownstreamExtractsWithWarnings />');
    expect(tds).toContain("class='hyper'");
    expect(tds).toContain("dbname='Data/Extracts/federated_abc.hyper'");
    const oid = dataCloudObjectId('Account', 'ssot__Account__dlm');
    expect(tds).toContain(`table='[Extract].[${oid}]'`);
    expect(tds).toContain("context='extract'");
    expect(tds).toContain("<properties context=''>");
  });

  it('throws when an extract is requested without a hyperDbname', () => {
    expect(() =>
      generateDataCloudTds({
        datasourceName: 'x',
        connection: conn,
        materialization: 'extract',
        object: 'ssot__Account__dlm',
        caption: 'Account',
        columns: accountColumns,
      }),
    ).toThrow();
  });
});

describe('generateDataCloudRelationshipsTds (multi-object)', () => {
  const tds = generateDataCloudRelationshipsTds({
    datasourceName: 'Account Contact DS',
    connection: conn,
    materialization: 'extract',
    tables: [
      { object: 'ssot__Account__dlm', caption: 'Account', columns: accountColumns },
      { object: 'ssot__Contact__dlm', caption: 'Account Contact', columns: contactColumns },
    ],
    relationships: [
      {
        leftObject: 'ssot__Contact__dlm',
        leftField: 'ssot__AccountId__c',
        rightObject: 'ssot__Account__dlm',
        rightField: 'ssot__Id__c',
      },
    ],
    extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
  });

  it('disambiguates colliding local-names with (caption)', () => {
    const identities = dataCloudFieldIdentities([
      { object: 'ssot__Account__dlm', caption: 'Account', columns: accountColumns },
      { object: 'ssot__Contact__dlm', caption: 'Account Contact', columns: contactColumns },
    ]);
    const idLocals = identities.filter((i) => i.real === 'ssot__Id__c').map((i) => i.local);
    expect(idLocals).toContain('ssot__Id__c');
    expect(idLocals).toContain('ssot__Id__c (Account Contact)');
    expect(tds).toContain('<local-name>[ssot__Id__c]</local-name>');
    expect(tds).toContain('<local-name>[ssot__Id__c (Account Contact)]</local-name>');
    expect(tds).toContain('<remote-name>ssot__Id__c</remote-name>');
  });

  it('keeps object-id captions with spaces', () => {
    const oid = dataCloudObjectId('Account Contact', 'ssot__Contact__dlm');
    expect(oid).toContain('Account Contact_');
    expect(tds).toContain(`table='[Extract].[${oid}]'`);
  });

  it('still uses [public].[apiName] on the live relation', () => {
    expect(tds).toContain("table='[public].[ssot__Account__dlm]'");
    expect(tds).toContain("table='[public].[ssot__Contact__dlm]'");
  });
});

describe('generateDataCloudPhysicalJoinTds', () => {
  const tds = generateDataCloudPhysicalJoinTds({
    datasourceName: 'Joined DC',
    connection: conn,
    materialization: 'live',
    tables: [
      { object: 'ssot__Account__dlm', caption: 'Account', columns: accountColumns },
      { object: 'ssot__Contact__dlm', caption: 'Contact', columns: contactColumns },
    ],
    relationships: [
      {
        leftObject: 'ssot__Contact__dlm',
        leftField: 'ssot__AccountId__c',
        rightObject: 'ssot__Account__dlm',
        rightField: 'ssot__Id__c',
        joinType: 'left',
      },
    ],
  });

  it('emits a live join tree without an extract', () => {
    expect(tds).toContain("type='join'");
    expect(tds).not.toContain('<extract ');
    expect(tds).toContain("class='salesforce-genie'");
  });
});
