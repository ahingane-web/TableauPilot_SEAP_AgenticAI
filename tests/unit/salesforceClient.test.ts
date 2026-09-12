import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  login,
  listObjects,
  describeObject,
  queryRecords,
  normalizeLoginUrl,
  type SalesforceSession,
} from '../../src/salesforce/client.js';

function mockFetchOnce(status: number, body: string, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    })) as unknown as typeof fetch,
  );
}

/** Stub fetch to return a queued sequence of JSON responses, capturing requested URLs. */
function mockFetchSequence(bodies: string[]): { urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url));
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return {
        ok: true,
        status: 200,
        text: async () => body,
        headers: { get: () => null },
      };
    }) as unknown as typeof fetch,
  );
  return { urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeLoginUrl', () => {
  it('adds https and strips path', () => {
    expect(normalizeLoginUrl('login.salesforce.com')).toBe('https://login.salesforce.com');
    expect(normalizeLoginUrl('https://x.my.salesforce.com/services/foo')).toBe('https://x.my.salesforce.com');
  });
  it('throws on empty', () => {
    expect(() => normalizeLoginUrl('')).toThrow();
  });
});

describe('login', () => {
  it('parses sessionId and instance origin from a SOAP login response', async () => {
    const soap =
      `<?xml version="1.0"?><soapenv:Envelope><soapenv:Body><loginResponse><result>` +
      `<sessionId>SESSION-123</sessionId>` +
      `<serverUrl>https://mydomain.my.salesforce.com/services/Soap/u/59.0/00Dxx</serverUrl>` +
      `</result></loginResponse></soapenv:Body></soapenv:Envelope>`;
    mockFetchOnce(200, soap);
    const session = await login({ url: 'https://login.salesforce.com', username: 'u@e.com', password: 'pw', token: 'tok' });
    expect(session.accessToken).toBe('SESSION-123');
    expect(session.instanceUrl).toBe('https://mydomain.my.salesforce.com');
  });

  it('throws AUTH_FAILED with the SOAP faultstring on invalid login', async () => {
    const fault =
      `<soapenv:Envelope><soapenv:Body><soapenv:Fault>` +
      `<faultstring>INVALID_LOGIN: Invalid username, password, security token</faultstring>` +
      `</soapenv:Fault></soapenv:Body></soapenv:Envelope>`;
    mockFetchOnce(500, fault);
    await expect(login({ url: 'https://login.salesforce.com', username: 'u@e.com', password: 'bad' })).rejects.toThrow(
      /Salesforce login failed/,
    );
  });
});

describe('listObjects', () => {
  const session: SalesforceSession = {
    instanceUrl: 'https://mydomain.my.salesforce.com',
    accessToken: 'SESSION-123',
    apiVersion: '59.0',
  };

  it('returns queryable objects sorted by label', async () => {
    const body = JSON.stringify({
      sobjects: [
        { name: 'Opportunity', label: 'Opportunity', queryable: true },
        { name: 'Account', label: 'Account', queryable: true },
        { name: 'SecretThing', label: 'Secret', queryable: false },
      ],
    });
    mockFetchOnce(200, body);
    const tables = await listObjects(session);
    expect(tables.map((t) => t.name)).toEqual(['Account', 'Opportunity']);
  });

  it('surfaces a Salesforce REST error message', async () => {
    mockFetchOnce(400, JSON.stringify([{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]));
    await expect(listObjects(session)).rejects.toThrow(/Salesforce API error/);
  });
});

describe('describeObject', () => {
  const session: SalesforceSession = {
    instanceUrl: 'https://mydomain.my.salesforce.com',
    accessToken: 'SESSION-123',
    apiVersion: '59.0',
  };

  it('returns the object fields with nillable', async () => {
    mockFetchOnce(
      200,
      JSON.stringify({
        fields: [
          { name: 'Name', label: 'Account Name', type: 'string', nillable: false },
          { name: 'Notes', label: 'Notes', type: 'string', nillable: true },
          { name: 'SystemField', label: 'System', type: 'string' },
        ],
      }),
    );
    const fields = await describeObject(session, 'Account');
    expect(fields).toEqual([
      { name: 'Name', label: 'Account Name', type: 'string', nillable: false },
      { name: 'Notes', label: 'Notes', type: 'string', nillable: true },
      // describe omitted `nillable` -> default nullable (true)
      { name: 'SystemField', label: 'System', type: 'string', nillable: true },
    ]);
  });

  it('excludes compound (address/location) and base64 fields that break extract queries', async () => {
    mockFetchOnce(
      200,
      JSON.stringify({
        fields: [
          { name: 'Name', label: 'Name', type: 'string' },
          { name: 'MailingAddress', label: 'Mailing Address', type: 'address' },
          { name: 'MailingCity', label: 'Mailing City', type: 'string' },
          { name: 'Location', label: 'Location', type: 'location' },
          { name: 'Body', label: 'Body', type: 'base64' },
        ],
      }),
    );
    const fields = await describeObject(session, 'Contact');
    expect(fields.map((f) => f.name)).toEqual(['Name', 'MailingCity']);
  });

  it('rejects an invalid object name without calling fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    await expect(describeObject(session, 'Bad Name')).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('queryRecords', () => {
  const session: SalesforceSession = {
    instanceUrl: 'https://mydomain.my.salesforce.com',
    accessToken: 'SESSION-123',
    apiVersion: '59.0',
  };

  it('follows nextRecordsUrl pagination and aligns rows to field order, stripping attributes', async () => {
    const { urls } = mockFetchSequence([
      JSON.stringify({
        done: false,
        nextRecordsUrl: '/services/data/v59.0/query/01g-2000',
        records: [{ attributes: { type: 'Contact' }, Id: '001', Name: 'Ada' }],
      }),
      JSON.stringify({
        done: true,
        records: [{ attributes: { type: 'Contact' }, Id: '002', Name: 'Alan' }],
      }),
    ]);
    const rows = await queryRecords(session, 'Contact', ['Id', 'Name']);
    expect(rows).toEqual([
      ['001', 'Ada'],
      ['002', 'Alan'],
    ]);
    // first page is the SOQL query URL; second follows nextRecordsUrl
    expect(urls[0]).toContain('/services/data/v59.0/query?q=');
    expect(urls[0]).toContain(encodeURIComponent('SELECT Id, Name FROM Contact'));
    expect(urls[1]).toContain('https://mydomain.my.salesforce.com/services/data/v59.0/query/01g-2000');
  });

  it('fills missing fields with null and honors the maxRows cap', async () => {
    mockFetchSequence([
      JSON.stringify({
        done: false,
        nextRecordsUrl: '/services/data/v59.0/query/next',
        records: [
          { attributes: {}, Id: '001' },
          { attributes: {}, Id: '002', Name: 'Has Name' },
        ],
      }),
    ]);
    const rows = await queryRecords(session, 'Contact', ['Id', 'Name'], 1);
    expect(rows).toEqual([['001', null]]); // capped at 1 row, missing Name -> null
  });

  it('rejects when no valid fields are provided', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    await expect(queryRecords(session, 'Contact', ['bad field'])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
