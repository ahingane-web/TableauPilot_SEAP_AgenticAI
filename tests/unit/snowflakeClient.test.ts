import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  connect,
  listWarehouses,
  listDatabases,
  listSchemas,
  listTables,
  describeTable,
  queryRows,
  snowflakeToTwbType,
  snowflakeToHyperType,
  quoteIdent,
  normalizeSnowflakeUrl,
  type SnowflakeAuth,
} from '../../src/snowflake/client.js';

const auth: SnowflakeAuth = {
  token: 'sf-token',
  host: 'xy12345.snowflakecomputing.com',
  origin: 'https://xy12345.snowflakecomputing.com',
  account: 'xy12345',
  username: 'JANE',
  warehouse: 'COMPUTE_WH',
  sequenceId: 1,
};

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

function showBody(names: string[], nameCol = 'name'): { success: true; data: { rowtype: Array<{ name: string }>; rowset: string[][] } } {
  return {
    success: true,
    data: {
      rowtype: [{ name: nameCol }],
      rowset: names.map((n) => [n]),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeSnowflakeUrl', () => {
  it('accepts a host or https URL and parses the account', () => {
    expect(normalizeSnowflakeUrl('xy12345.snowflakecomputing.com')).toEqual({
      origin: 'https://xy12345.snowflakecomputing.com',
      host: 'xy12345.snowflakecomputing.com',
      account: 'xy12345',
    });
    expect(normalizeSnowflakeUrl('https://ORG-ACCT.snowflakecomputing.com/')).toEqual({
      origin: 'https://org-acct.snowflakecomputing.com',
      host: 'org-acct.snowflakecomputing.com',
      account: 'org-acct',
    });
  });

  it('rejects non-Snowflake hosts', () => {
    expect(() => normalizeSnowflakeUrl('https://example.com')).toThrow(/snowflakecomputing/);
  });
});

describe('quoteIdent', () => {
  it('double-quotes and escapes embedded quotes', () => {
    expect(quoteIdent('ORDERS')).toBe('"ORDERS"');
    expect(quoteIdent('Order Date')).toBe('"Order Date"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe('type mappers', () => {
  it('maps Snowflake types to Twb tokens', () => {
    expect(snowflakeToTwbType('NUMBER(38,0)')).toBe('integer');
    expect(snowflakeToTwbType('NUMBER(18,2)')).toBe('real');
    expect(snowflakeToTwbType('INTEGER')).toBe('integer');
    expect(snowflakeToTwbType('FLOAT')).toBe('real');
    expect(snowflakeToTwbType('BOOLEAN')).toBe('boolean');
    expect(snowflakeToTwbType('DATE')).toBe('date');
    expect(snowflakeToTwbType('TIMESTAMP_NTZ')).toBe('datetime');
    expect(snowflakeToTwbType('VARCHAR')).toBe('string');
  });

  it('maps Snowflake types to Hyper categories', () => {
    expect(snowflakeToHyperType('NUMBER(38,0)')).toBe('int');
    expect(snowflakeToHyperType('NUMBER(10,4)')).toBe('double');
    expect(snowflakeToHyperType('BOOLEAN')).toBe('bool');
    expect(snowflakeToHyperType('DATE')).toBe('date');
    expect(snowflakeToHyperType('TIMESTAMP_LTZ')).toBe('timestamp');
    expect(snowflakeToHyperType('TEXT')).toBe('text');
  });
});

describe('connect', () => {
  it('posts username/password to the session login endpoint and returns a token', async () => {
    mockFetch((url) => {
      if (url.includes('/session/v1/login-request')) {
        return { body: { success: true, data: { token: 'sess-1' } } };
      }
      return { status: 404, body: {} };
    });
    const result = await connect({
      url: 'xy12345.snowflakecomputing.com',
      warehouse: 'COMPUTE_WH',
      username: 'JANE',
      password: 'secret',
    });
    expect(result.token).toBe('sess-1');
    expect(result.host).toBe('xy12345.snowflakecomputing.com');
    expect(result.warehouse).toBe('COMPUTE_WH');
    expect(result.username).toBe('JANE');
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(call[0])).toContain('warehouse=COMPUTE_WH');
    expect(String(call[0])).toContain('requestId=');
    expect(JSON.parse(String(call[1]?.body))).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ LOGIN_NAME: 'JANE', ACCOUNT_NAME: 'xy12345' }),
      }),
    );
  });

  it('surfaces a failed login', async () => {
    mockFetch(() => ({ body: { success: false, message: 'Incorrect username or password' } }));
    await expect(
      connect({
        url: 'xy12345.snowflakecomputing.com',
        warehouse: 'COMPUTE_WH',
        username: 'JANE',
        password: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});

describe('list helpers', () => {
  it('lists warehouses, databases, schemas, and tables from SHOW rowsets', async () => {
    mockFetch((_url, init) => {
      const sql = JSON.parse(String(init?.body ?? '{}')).sqlText as string;
      if (sql === 'SHOW WAREHOUSES') return { body: showBody(['COMPUTE_WH', 'LOAD_WH']) };
      if (sql.startsWith('SHOW DATABASES')) return { body: showBody(['TABLEAUAGENT']) };
      if (sql.startsWith('SHOW SCHEMAS')) {
        return { body: showBody(['PUBLIC', 'INFORMATION_SCHEMA']) };
      }
      if (sql.startsWith('SHOW TABLES')) return { body: showBody(['ORDERS', 'PEOPLE']) };
      return { body: { success: true, data: { rowtype: [], rowset: [] } } };
    });
    const session = { ...auth };
    expect((await listWarehouses(session)).map((w) => w.name)).toEqual(['COMPUTE_WH', 'LOAD_WH']);
    expect((await listDatabases(session, 'COMPUTE_WH')).map((d) => d.name)).toEqual(['TABLEAUAGENT']);
    expect((await listSchemas(session, 'COMPUTE_WH', 'TABLEAUAGENT')).map((s) => s.name)).toEqual(['PUBLIC']);
    expect((await listTables(session, 'COMPUTE_WH', 'TABLEAUAGENT', 'PUBLIC')).map((t) => t.name)).toEqual([
      'ORDERS',
      'PEOPLE',
    ]);
  });

  it('reads the name column even when SHOW puts created_on first', async () => {
    mockFetch(() => ({
      body: {
        success: true,
        data: {
          rowtype: [{ name: 'created_on' }, { name: 'name' }, { name: 'state' }],
          rowset: [
            ['2024-01-01', 'COMPUTE_WH', 'STARTED'],
            ['2024-01-02', 'LOAD_WH', 'SUSPENDED'],
          ],
        },
      },
    }));
    expect((await listWarehouses({ ...auth })).map((w) => w.name)).toEqual(['COMPUTE_WH', 'LOAD_WH']);
  });
});

describe('describeTable', () => {
  it('returns scalar columns and skips VARIANT', async () => {
    mockFetch(() => ({
      body: {
        success: true,
        data: {
          rowtype: [{ name: 'name' }, { name: 'type' }, { name: 'null?' }],
          rowset: [
            ['Row ID', 'NUMBER(38,0)', 'Y'],
            ['Order Date', 'DATE', 'Y'],
            ['payload', 'VARIANT', 'Y'],
            ['Sales', 'NUMBER(18,2)', 'Y'],
          ],
        },
      },
    }));
    const fields = await describeTable({ ...auth }, 'COMPUTE_WH', 'TABLEAUAGENT', 'PUBLIC', 'ORDERS');
    expect(fields.map((f) => f.name)).toEqual(['Row ID', 'Order Date', 'Sales']);
    expect(fields.find((f) => f.name === 'payload')).toBeUndefined();
  });
});

describe('queryRows', () => {
  it('coerces dates and timestamps to sidecar formats', async () => {
    mockFetch((_url, init) => {
      const sql = JSON.parse(String(init?.body ?? '{}')).sqlText as string;
      expect(sql).toContain('LIMIT');
      return {
        body: {
          success: true,
          data: {
            rowtype: [{ name: 'Row ID' }, { name: 'Order Date' }, { name: 'Shipped' }],
            rowset: [['1', '2020-01-02', '2024-03-15 12:30:00.000']],
          },
        },
      };
    });
    const rows = await queryRows(
      { ...auth },
      {
        warehouse: 'COMPUTE_WH',
        database: 'TABLEAUAGENT',
        schema: 'PUBLIC',
        table: 'ORDERS',
        fields: [
          { name: 'Row ID', label: 'Row ID', type: 'NUMBER(38,0)', nillable: false },
          { name: 'Order Date', label: 'Order Date', type: 'DATE', nillable: true },
          { name: 'Shipped', label: 'Shipped', type: 'TIMESTAMP_NTZ', nillable: true },
        ],
      },
    );
    expect(rows).toEqual([[1, '2020-01-02', '2024-03-15T12:30:00']]);
  });

  it('keeps null middle columns instead of substituting another cell', async () => {
    mockFetch(() => ({
      body: {
        success: true,
        data: {
          rowtype: [{ name: 'Row ID' }, { name: 'Order Date' }, { name: 'Sales' }],
          rowset: [['1', null, '9.5']],
        },
      },
    }));
    const rows = await queryRows(
      { ...auth },
      {
        warehouse: 'COMPUTE_WH',
        database: 'TABLEAUAGENT',
        schema: 'PUBLIC',
        table: 'ORDERS',
        fields: [
          { name: 'Row ID', label: 'Row ID', type: 'NUMBER(38,0)', nillable: false },
          { name: 'Order Date', label: 'Order Date', type: 'DATE', nillable: true },
          { name: 'Sales', label: 'Sales', type: 'NUMBER(18,2)', nillable: true },
        ],
      },
    );
    expect(rows).toEqual([[1, null, 9.5]]);
  });
});
