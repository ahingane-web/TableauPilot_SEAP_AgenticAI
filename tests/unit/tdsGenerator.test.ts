import { describe, it, expect } from 'vitest';
import {
  generateSalesforceTds,
  salesforceToTwbDataType,
  authAttrForMode,
  DEFAULT_SALESFORCE_API_VERSION,
} from '../../src/tableau/authoring/tdsGenerator.js';

describe('salesforceToTwbDataType', () => {
  it('maps Salesforce soap types to Tableau datatypes', () => {
    expect(salesforceToTwbDataType('boolean')).toBe('boolean');
    expect(salesforceToTwbDataType('int')).toBe('integer');
    expect(salesforceToTwbDataType('double')).toBe('real');
    expect(salesforceToTwbDataType('currency')).toBe('real');
    expect(salesforceToTwbDataType('percent')).toBe('real');
    expect(salesforceToTwbDataType('date')).toBe('date');
    expect(salesforceToTwbDataType('datetime')).toBe('datetime');
    expect(salesforceToTwbDataType('id')).toBe('string');
    expect(salesforceToTwbDataType('picklist')).toBe('string');
    expect(salesforceToTwbDataType('anything-else')).toBe('string');
  });
});

describe('generateSalesforceTds', () => {
  const tds = generateSalesforceTds({
    datasourceName: 'Salesforce Account DS',
    serverHost: 'storm-4e502ee95bef89.my.salesforce.com',
    username: 'user@example.com',
    object: 'Account',
  });

  it('produces a well-formed .tds root', () => {
    expect(tds.startsWith("<?xml version='1.0'")).toBe(true);
    expect(tds).toContain('<datasource ');
    expect(tds).toContain('</datasource>');
  });

  it('mirrors the reference Salesforce OAuth connection block (default mode)', () => {
    expect(tds).toContain("<connection class='federated'>");
    expect(tds).toContain("class='salesforce'");
    // Reconciled against reference/Salesforce_Account_DS.tds (default authMode = oauth):
    expect(tds).toContain("authentication='auth-oauth'");
    expect(tds).toContain("server-oauth='server-custom'");
    expect(tds).toContain("compressed-responses='yes'");
    expect(tds).toContain("pagesize='200'");
    expect(tds).toContain("maxfieldlength='4096'");
    expect(tds).toContain(`salesforce-api-version='${DEFAULT_SALESFORCE_API_VERSION}'`);
    expect(tds).toContain("server='storm-4e502ee95bef89.my.salesforce.com'");
    expect(tds).toContain("username='user@example.com'");
  });

  it('emits a username/password connection when authMode is username-password', () => {
    const up = generateSalesforceTds({
      datasourceName: 'X',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object: 'Account',
      authMode: 'username-password',
    });
    expect(up).toContain("authentication='auth-user-pass'");
    expect(up).not.toContain('server-oauth=');
    expect(up).not.toContain("authentication='auth-oauth'");
  });

  it('omits server-custom when serverOauthCustom is false (built-in OAuth client)', () => {
    const builtin = generateSalesforceTds({
      datasourceName: 'X',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object: 'Account',
      authMode: 'oauth',
      serverOauthCustom: false,
    });
    expect(builtin).toContain("authentication='auth-oauth'");
    expect(builtin).not.toContain('server-oauth=');
  });

  it('authAttrForMode maps modes to Tableau auth values', () => {
    expect(authAttrForMode('oauth')).toBe('auth-oauth');
    expect(authAttrForMode('username-password')).toBe('auth-user-pass');
  });

  it('does NOT use a login-server attribute (reference uses instance host as server)', () => {
    expect(tds).not.toContain('login-server=');
  });

  it('emits datasource-level <column> elements when described fields are provided', () => {
    const withCols = generateSalesforceTds({
      datasourceName: 'DS',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object: 'Account',
      fields: [
        { name: 'Name', salesforceType: 'string' },
        { name: 'AnnualRevenue', salesforceType: 'double' },
        { name: 'CreatedDate', salesforceType: 'datetime' },
      ],
    });
    expect(withCols).toContain("<column datatype='string' name='[Name]' role='dimension' type='nominal' />");
    expect(withCols).toContain("<column datatype='real' name='[AnnualRevenue]' role='measure' type='quantitative' />");
    expect(withCols).toContain("<column datatype='datetime' name='[CreatedDate]' role='dimension' type='ordinal' />");
  });

  it('emits connection <cols> map + <metadata-records> that constrain the extract query', () => {
    const withMeta = generateSalesforceTds({
      datasourceName: 'DS',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object: 'Account',
      fields: [
        { name: 'Name', salesforceType: 'string', nillable: false },
        { name: 'AnnualRevenue', salesforceType: 'double', nillable: true },
        { name: 'IsDeleted', salesforceType: 'boolean' },
        { name: 'CreatedDate', salesforceType: 'datetime' },
        { name: 'BirthDate', salesforceType: 'date' },
      ],
    });
    // <cols> alias map (key = field, value = [Object].[Field])
    expect(withMeta).toContain('<cols>');
    expect(withMeta).toContain("<map key='[Name]' value='[Account].[Name]' />");
    expect(withMeta).toContain("<map key='[AnnualRevenue]' value='[Account].[AnnualRevenue]' />");
    // metadata-records with correct remote-type codes per Tableau OLE-DB mapping
    expect(withMeta).toContain('<metadata-records>');
    expect(withMeta).toContain("<metadata-record class='column'>");
    expect(withMeta).toContain('<remote-name>Name</remote-name>');
    expect(withMeta).toContain('<remote-type>130</remote-type>'); // string
    expect(withMeta).toContain('<remote-type>5</remote-type>'); // real
    expect(withMeta).toContain('<remote-type>11</remote-type>'); // boolean
    expect(withMeta).toContain('<remote-type>135</remote-type>'); // datetime
    expect(withMeta).toContain('<remote-type>133</remote-type>'); // date
    // contains-null reflects nillable (Name = not null, AnnualRevenue = null, default = null)
    expect(withMeta).toContain('<contains-null>false</contains-null>');
    expect(withMeta).toContain('<contains-null>true</contains-null>');
    // aggregation: Sum for numeric measures, Count otherwise
    expect(withMeta).toContain('<aggregation>Sum</aggregation>');
    expect(withMeta).toContain('<aggregation>Count</aggregation>');
    // shared, deterministic object-id
    expect(withMeta).toContain('<object-id>[Account (Account)_');
    // still a LIVE datasource: Tableau builds the extract server-side, we never embed one
    expect(withMeta).not.toContain('<extract');
    expect(withMeta).not.toContain("class='hyper'");
  });

  it('emits no <cols> / <metadata-records> when no fields are provided', () => {
    expect(tds).not.toContain('<cols>');
    expect(tds).not.toContain('<metadata-records>');
  });

  it('does NOT emit an <extract> element unless requested', () => {
    const noExtract = generateSalesforceTds({
      datasourceName: 'DS',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object: 'Account',
      fields: [{ name: 'Name', salesforceType: 'string' }],
    });
    expect(noExtract).not.toContain('<extract');
    expect(noExtract).not.toContain("class='hyper'");
  });

  it('emits an <extract> backed by a hyper connection when extract is requested', () => {
    const withExtract = generateSalesforceTds({
      datasourceName: 'DS',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object: 'Contact',
      fields: [
        { name: 'Id', salesforceType: 'id' },
        { name: 'Amount', salesforceType: 'double' },
      ],
      extract: { hyperDbname: 'Data/Extracts/federated_abc.hyper' },
    });
    expect(withExtract).toContain("<extract count='-1' enabled='true' object-id='Contact (Contact)_");
    expect(withExtract).toContain(
      "<connection authentication='auth-none' class='hyper' dbname='Data/Extracts/federated_abc.hyper' " +
        "default-settings='yes' schema='Extract' tablename='Extract'>",
    );
    expect(withExtract).toContain("<relation name='Contact' table='[Extract].[Contact]' type='table' />");
    // extract carries its own cols map + metadata-records mirroring the field set
    expect(withExtract).toContain("<map key='[Amount]' value='[Contact].[Amount]' />");
    expect(withExtract).toContain('<remote-name>Amount</remote-name>');
    // the <extract object-id=...> uses the bare (unbracketed) id; metadata keeps brackets
    expect(withExtract).toContain('<object-id>[Contact (Contact)_');
    expect(withExtract).not.toContain("object-id='[Contact");
  });

  it('emits no <column> elements when no fields are provided (bare live datasource)', () => {
    expect(tds).not.toContain('<column ');
  });

  it('emits a single relation for the chosen object', () => {
    expect(tds).toContain(
      "<relation connection='salesforce.tableaupilot' name='Account' table='[Account]' type='table' />",
    );
  });

  it('is a LIVE datasource (no embedded extract / hyper)', () => {
    expect(tds).not.toContain('<extract');
    expect(tds).not.toContain("class='hyper'");
    // A live connection resolves its own schema — we do not emit logical columns.
    expect(tds).not.toContain('<column ');
  });

  it('rejects an invalid object name', () => {
    expect(() =>
      generateSalesforceTds({
        datasourceName: 'X',
        serverHost: 'x.my.salesforce.com',
        username: 'u@e.com',
        object: 'Account; DROP',
      }),
    ).toThrow();
  });
});
