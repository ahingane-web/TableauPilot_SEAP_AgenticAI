import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/salesforce/client.js', () => ({
  login: vi.fn(async () => ({
    instanceUrl: 'https://org.my.salesforce.com',
    accessToken: 'sf-token',
    apiVersion: '59.0',
  })),
}));

import {
  connect,
  listDataSpaces,
  listObjects,
  describeObject,
  queryRows,
  classifyObject,
  dataCloudToTwbType,
  dataCloudToHyperType,
  type DataCloudAuth,
} from '../../src/datacloud/client.js';

const auth: DataCloudAuth = {
  accessToken: 'cdp-token',
  instanceUrl: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.c360a.salesforce.com',
  coreInstanceUrl: 'https://org.my.salesforce.com',
  coreAccessToken: 'sf-token',
  apiVersion: '59.0',
  tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pod: 'prod21',
};

function jwtWith(claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status = 200, body } = handler(String(url), init);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('type mappers', () => {
  it('maps Data Cloud types to Twb tokens', () => {
    expect(dataCloudToTwbType('INTEGER')).toBe('integer');
    expect(dataCloudToTwbType('NUMBER')).toBe('real');
    expect(dataCloudToTwbType('BOOLEAN')).toBe('boolean');
    expect(dataCloudToTwbType('DATE')).toBe('date');
    expect(dataCloudToTwbType('DATETIME')).toBe('datetime');
    expect(dataCloudToTwbType('DATE_TIME')).toBe('datetime');
    expect(dataCloudToTwbType('STRING')).toBe('string');
  });

  it('maps Data Cloud types to Hyper categories', () => {
    expect(dataCloudToHyperType('INTEGER')).toBe('int');
    expect(dataCloudToHyperType('NUMBER')).toBe('double');
    expect(dataCloudToHyperType('BOOLEAN')).toBe('bool');
    expect(dataCloudToHyperType('DATE')).toBe('date');
    expect(dataCloudToHyperType('TIMESTAMP')).toBe('timestamp');
    expect(dataCloudToHyperType('STRING')).toBe('text');
  });
});

describe('classifyObject', () => {
  it('uses API-name suffixes', () => {
    expect(classifyObject({ name: 'ssot__Account__dlm' })).toBe('dmo');
    expect(classifyObject({ name: 'ssot__Foo__dll' })).toBe('dlo');
    expect(classifyObject({ name: 'commerce_accounts', type: 'DataLakeObject' })).toBe('dlo');
    expect(classifyObject({ name: 'Avg_Spends__cio' })).toBe('ci');
    expect(classifyObject({ name: 'ssot__Bar__cio' })).toBe('ci');
    expect(classifyObject({ name: 'ssot__Baz__ci' })).toBe('ci');
  });
});

describe('connect (SOAP login + CDP token exchange)', () => {
  it('exchanges the Salesforce access token for a CDP token and captures tenant/pod', async () => {
    const token = jwtWith({ pod: 'prod21', tenantId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    mockFetch((url) => {
      if (url.includes('/services/a360/token')) {
        return {
          body: {
            access_token: token,
            instance_url: 'https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.c360a.salesforce.com',
            tenant_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        };
      }
      return { status: 404, body: {} };
    });
    const result = await connect({
      url: 'https://login.salesforce.com',
      username: 'jane.doe@example.com',
      password: 'secret',
    });
    expect(result.sfSession.instanceUrl).toBe('https://org.my.salesforce.com');
    expect(result.cdp.accessToken).toBe(token);
    expect(result.cdp.instanceUrl).toBe('https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.c360a.salesforce.com');
    expect(result.cdp.tenantId).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(result.cdp.pod).toBe('prod21');
    expect(result.cdp.coreAccessToken).toBe('sf-token');
  });
});

describe('listDataSpaces', () => {
  it('returns data spaces from the CDP host', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/v1/dataSpaces')) {
        return { body: { dataSpaces: [{ name: 'default', label: 'Default' }, { name: 'analytics' }] } };
      }
      return { status: 404, body: {} };
    });
    const spaces = await listDataSpaces(auth);
    expect(spaces.map((s) => s.name)).toEqual(['default', 'analytics']);
    expect(spaces[0]?.label).toBe('Default');
  });

  it('falls back to Connect REST ssot/data-spaces when CDP returns none', async () => {
    mockFetch((url) => {
      if (url.includes('/api/v1/dataSpaces')) return { body: { dataSpaces: [] } };
      if (url.includes('/ssot/data-spaces') || url.includes('/ssot/dataspaces')) {
        return { body: { dataSpaces: [{ name: 'default', label: 'Default Space' }] } };
      }
      return { status: 404, body: {} };
    });
    const spaces = await listDataSpaces(auth);
    expect(spaces).toEqual([{ name: 'default', label: 'Default Space' }]);
  });
});

const metadata = {
  metadata: [
    {
      name: 'ssot__Account__dlm',
      displayName: 'Account',
      fields: [
        { name: 'ssot__Id__c', type: 'STRING' },
        { name: 'ssot__Name__c', type: 'STRING' },
        { name: 'nested', type: 'STRUCT' },
      ],
    },
    { name: 'ssot__Foo__dll', displayName: 'Foo Lake', fields: [{ name: 'ssot__Id__c', type: 'STRING' }] },
    { name: 'ssot__Bar__cio', displayName: 'Bar Insight', fields: [{ name: 'ssot__Id__c', type: 'STRING' }] },
  ],
};

describe('listObjects', () => {
  it('filters objects by category', async () => {
    mockFetch(() => ({ body: metadata }));
    const all = await listObjects(auth, 'default', 'all');
    expect(all.map((o) => o.category).sort()).toEqual(['ci', 'dlo', 'dmo']);
    const dmo = await listObjects(auth, 'default', 'dmo');
    expect(dmo.map((o) => o.name)).toEqual(['ssot__Account__dlm']);
    const dlo = await listObjects(auth, 'default', 'dlo');
    expect(dlo.map((o) => o.name)).toEqual(['ssot__Foo__dll']);
    const ci = await listObjects(auth, 'default', 'ci');
    expect(ci.map((o) => o.name)).toEqual(['ssot__Bar__cio']);
  });
});

describe('describeObject', () => {
  it('returns scalar fields and skips nested types', async () => {
    mockFetch(() => ({ body: metadata }));
    const fields = await describeObject(auth, 'default', 'ssot__Account__dlm');
    expect(fields.map((f) => f.name)).toEqual(['ssot__Id__c', 'ssot__Name__c']);
    expect(fields.find((f) => f.name === 'nested')).toBeUndefined();
  });

  it('does not describe a different object when the named one is missing', async () => {
    mockFetch(() => ({ body: metadata }));
    await expect(describeObject(auth, 'default', 'ssot__Missing__dlm')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reads Calculated Insight dimensions and measures', async () => {
    mockFetch(() => ({
      body: {
        metadata: [
          {
            name: 'Avg_Spends__cio',
            displayName: 'Avg Spends',
            type: 'CalculatedInsight',
            dimensions: [{ name: 'ssot__Id__c', type: 'STRING' }],
            measures: [{ name: 'avg_amount', type: 'NUMBER' }],
          },
        ],
      },
    }));
    const fields = await describeObject(auth, 'default', 'Avg_Spends__cio');
    expect(fields.map((f) => f.name)).toEqual(['ssot__Id__c', 'avg_amount']);
  });
});

describe('queryRows', () => {
  it('coerces dates and timestamps to sidecar formats', async () => {
    mockFetch((url, init) => {
      if (String(init?.method ?? 'GET').toUpperCase() === 'POST' && url.includes('/api/v2/query')) {
        return {
          body: {
            data: [
              {
                ssot__Id__c: '1',
                ssot__CreatedDate__c: '2024-03-15 12:30:00.000',
                ssot__BirthDate__c: '2020-01-02T00:00:00Z',
              },
            ],
            done: true,
          },
        };
      }
      return { status: 404, body: {} };
    });
    const rows = await queryRows(auth, {
      dataSpace: 'default',
      objectName: 'ssot__Account__dlm',
      fields: [
        { name: 'ssot__Id__c', label: 'Id', type: 'STRING', nillable: false },
        { name: 'ssot__CreatedDate__c', label: 'Created', type: 'DATETIME', nillable: true },
        { name: 'ssot__BirthDate__c', label: 'Born', type: 'DATE', nillable: true },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe('1');
    expect(rows[0]?.[1]).toBe('2024-03-15T12:30:00');
    expect(rows[0]?.[2]).toBe('2020-01-02');
    const post = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[1]?.method ?? '').toUpperCase() === 'POST',
    );
    expect(post?.[1]?.headers).toEqual(expect.objectContaining({ dataspace: 'default' }));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).toEqual(expect.objectContaining({ sql: expect.any(String) }));
    expect(JSON.parse(String(post?.[1]?.body ?? '{}'))).not.toHaveProperty('dataspace');
  });
});
