import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { buildExtractTdsx, type ExtractColumn } from '../../src/tableau/publishing/hyperPackager.js';
import { generateSalesforceTds, generateSalesforceRelationshipsTds } from '../../src/tableau/authoring/tdsGenerator.js';
import { getConfig } from '../../src/config/env.js';

// The real build shells out to the Python Hyper sidecar. Skip when the virtualenv
// created by `npm run setup:hyper` is absent so the suite stays green everywhere.
const hasVenv = existsSync(getConfig().hyper.python);

describe.skipIf(!hasVenv)('buildExtractTdsx (real Hyper sidecar)', () => {
  it('materializes a .hyper and packages a .tdsx containing the tds + extract', async () => {
    const object = 'Contact';
    const hyperName = 'federated_test.hyper';
    const schema: ExtractColumn[] = [
      { name: 'Id', type: 'text' },
      { name: 'Amount', type: 'double' },
      { name: 'Active', type: 'bool' },
      { name: 'CreatedDate', type: 'timestamp' },
    ];
    const tdsXml = generateSalesforceTds({
      datasourceName: 'Contact Extract',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      object,
      fields: [
        { name: 'Id', salesforceType: 'id' },
        { name: 'Amount', salesforceType: 'double' },
        { name: 'Active', salesforceType: 'boolean' },
        { name: 'CreatedDate', salesforceType: 'datetime' },
      ],
      extract: { hyperDbname: `Data/Extracts/${hyperName}` },
    });
    const rows = [
      ['001', 12.5, true, '2024-01-15T10:30:00.000+0000'],
      ['002', null, false, null],
    ];

    const tdsx = await buildExtractTdsx({ tdsXml, object, hyperName, schema, rows });
    expect(Buffer.isBuffer(tdsx)).toBe(true);

    const entries = unzipSync(new Uint8Array(tdsx));
    const names = Object.keys(entries);
    // one .tds at the root and the .hyper under Data/Extracts/
    expect(names.some((n) => n.endsWith('.tds'))).toBe(true);
    expect(names).toContain(`Data/Extracts/${hyperName}`);
    // the .hyper is non-trivial (a real Hyper database file)
    const hyperBytes = entries[`Data/Extracts/${hyperName}`];
    expect(hyperBytes?.length ?? 0).toBeGreaterThan(1000);
  }, 30_000);

  it('materializes a MULTI-table extract (one Extract.<Object> per object) into one .hyper', async () => {
    const hyperName = 'federated_multi_test.hyper';
    const tdsXml = generateSalesforceRelationshipsTds({
      datasourceName: 'Account + Contact',
      serverHost: 'x.my.salesforce.com',
      username: 'u@e.com',
      tables: [
        { object: 'Account', fields: [{ name: 'Id', salesforceType: 'id' }, { name: 'Name', salesforceType: 'string' }] },
        { object: 'Contact', fields: [{ name: 'Id', salesforceType: 'id' }, { name: 'AccountId', salesforceType: 'reference' }] },
      ],
      relationships: [
        { leftObject: 'Account', leftField: 'Id', rightObject: 'Contact', rightField: 'AccountId', cardinality: 'one-to-many' },
      ],
      extract: { hyperDbname: `Data/Extracts/${hyperName}` },
    });

    const tdsx = await buildExtractTdsx({
      tdsXml,
      hyperName,
      tables: [
        {
          object: 'Account',
          schema: [
            { name: 'Id', type: 'text' },
            { name: 'Name', type: 'text' },
          ] as ExtractColumn[],
          rows: [
            ['001', 'Acme'],
            ['002', 'Globex'],
          ],
        },
        {
          object: 'Contact',
          schema: [
            { name: 'Id', type: 'text' },
            { name: 'AccountId', type: 'text' },
          ] as ExtractColumn[],
          rows: [['003', '001']],
        },
      ],
    });

    expect(Buffer.isBuffer(tdsx)).toBe(true);
    const entries = unzipSync(new Uint8Array(tdsx));
    const names = Object.keys(entries);
    expect(names.some((n) => n.endsWith('.tds'))).toBe(true);
    expect(names).toContain(`Data/Extracts/${hyperName}`);
    expect(entries[`Data/Extracts/${hyperName}`]?.length ?? 0).toBeGreaterThan(1000);
  }, 30_000);
});
