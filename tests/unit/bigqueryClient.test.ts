import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  listProjects,
  listDatasets,
  listTables,
  describeTable,
  queryRows,
  bigQueryToSalesforceToken,
  bigQueryToHyperType,
  toSafeIdentifier,
  type BigQueryAuth,
} from '../../src/bigquery/client.js';

const auth: BigQueryAuth = { accessToken: 'ya29.test-token' };

/** Stub fetch to return a queued sequence of JSON responses, capturing requested URLs. */
function mockFetchSequence(bodies: unknown[]): { urls: string[] } {
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
        text: async () => JSON.stringify(body),
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

describe('bigQueryToSalesforceToken', () => {
  it('maps BigQuery types to the shared .tds type tokens', () => {
    expect(bigQueryToSalesforceToken('INT64')).toBe('int');
    expect(bigQueryToSalesforceToken('FLOAT64')).toBe('double');
    expect(bigQueryToSalesforceToken('NUMERIC')).toBe('double');
    expect(bigQueryToSalesforceToken('BOOL')).toBe('boolean');
    expect(bigQueryToSalesforceToken('DATE')).toBe('date');
    expect(bigQueryToSalesforceToken('TIMESTAMP')).toBe('datetime');
    expect(bigQueryToSalesforceToken('STRING')).toBe('string');
  });
});

describe('bigQueryToHyperType', () => {
  it('maps BigQuery types to Hyper column categories', () => {
    expect(bigQueryToHyperType('INT64')).toBe('int');
    expect(bigQueryToHyperType('FLOAT64')).toBe('double');
    expect(bigQueryToHyperType('BOOL')).toBe('bool');
    expect(bigQueryToHyperType('DATE')).toBe('date');
    expect(bigQueryToHyperType('TIMESTAMP')).toBe('timestamp');
    expect(bigQueryToHyperType('STRING')).toBe('text');
  });
});

describe('toSafeIdentifier', () => {
  it('produces unique identifier-safe names from real BigQuery column names', () => {
    const used = new Set<string>();
    expect(toSafeIdentifier('Order Date', used)).toBe('Order_Date');
    expect(toSafeIdentifier('Sub-Category', used)).toBe('Sub_Category');
    // A name starting with a digit gets a safe prefix.
    expect(toSafeIdentifier('2024 Sales', used)).toMatch(/^F_?2024_Sales$/);
    // Duplicate resolves with a numeric suffix.
    expect(toSafeIdentifier('Order Date', used)).toBe('Order_Date_2');
  });
});

describe('listProjects', () => {
  it('returns active projects sorted by display name', async () => {
    mockFetchSequence([
      {
        projects: [
          { projectId: 'proj-b', name: 'Beta' },
          { projectId: 'proj-a', name: 'Alpha' },
        ],
      },
    ]);
    const projects = await listProjects(auth);
    expect(projects.map((p) => p.id)).toEqual(['proj-a', 'proj-b']);
    expect(projects[0]).toEqual({ id: 'proj-a', name: 'Alpha' });
  });
});

describe('listDatasets', () => {
  it('extracts dataset ids from datasetReference', async () => {
    const { urls } = mockFetchSequence([
      {
        datasets: [
          { datasetReference: { datasetId: 'Sales' }, location: 'US' },
          { datasetReference: { datasetId: 'Ops' } },
        ],
      },
    ]);
    const datasets = await listDatasets(auth, 'tableauagent-510111');
    expect(datasets.map((d) => d.id)).toEqual(['Ops', 'Sales']);
    expect(urls[0]).toContain('/projects/tableauagent-510111/datasets');
  });
});

describe('listTables', () => {
  it('extracts table ids from tableReference', async () => {
    mockFetchSequence([
      {
        tables: [
          { tableReference: { tableId: 'People' }, type: 'TABLE' },
          { tableReference: { tableId: 'Orders' }, type: 'TABLE' },
        ],
      },
    ]);
    const tables = await listTables(auth, 'tableauagent-510111', 'TableauAgentDataset');
    expect(tables.map((t) => t.id)).toEqual(['Orders', 'People']);
  });
});

describe('describeTable', () => {
  it('returns scalar columns with real + safe names and skips nested/repeated fields', async () => {
    mockFetchSequence([
      {
        schema: {
          fields: [
            { name: 'Order Date', type: 'DATE', mode: 'NULLABLE' },
            { name: 'Sales', type: 'FLOAT64', mode: 'REQUIRED' },
            { name: 'items', type: 'RECORD', mode: 'REPEATED' },
            { name: 'tags', type: 'STRING', mode: 'REPEATED' },
          ],
        },
      },
    ]);
    const fields = await describeTable(auth, 'data-proj', 'ds', 'Orders');
    expect(fields.map((f) => f.name)).toEqual(['Order Date', 'Sales']);
    expect(fields[0]).toMatchObject({ name: 'Order Date', safeName: 'Order_Date', type: 'DATE', nillable: true });
    expect(fields[1]).toMatchObject({ name: 'Sales', nillable: false });
  });
});

describe('queryRows', () => {
  it('builds a backtick-quoted SELECT and coerces values for the Hyper sidecar', async () => {
    const { urls } = mockFetchSequence([
      {
        jobReference: { jobId: 'job1' },
        rows: [
          { f: [{ v: '3' }, { v: '2024-01-15' }, { v: '1.5790842E9' }, { v: '19.99' }, { v: 'true' }] },
          { f: [{ v: null }, { v: null }, { v: null }, { v: null }, { v: 'false' }] },
        ],
      },
    ]);
    const fields = [
      { name: 'Row ID', safeName: 'Row_ID', type: 'INT64', nillable: true },
      { name: 'Order Date', safeName: 'Order_Date', type: 'DATE', nillable: true },
      { name: 'Created At', safeName: 'Created_At', type: 'TIMESTAMP', nillable: true },
      { name: 'Sales', safeName: 'Sales', type: 'FLOAT64', nillable: true },
      { name: 'Active', safeName: 'Active', type: 'BOOL', nillable: true },
    ];
    const rows = await queryRows(auth, {
      billingProjectId: 'billing-proj',
      projectId: 'data-proj',
      datasetId: 'ds',
      tableId: 'Orders',
      fields,
      maxRows: 100,
    });
    // The query runs against the BILLING project's /queries endpoint.
    expect(urls[0]).toContain('/projects/billing-proj/queries');
    expect(rows).toHaveLength(2);
    // Row 1: int truncated, date sliced, timestamp epoch-seconds -> ISO seconds, double, bool.
    expect(rows[0]![0]).toBe(3);
    expect(rows[0]![1]).toBe('2024-01-15');
    expect(rows[0]![2]).toBe('2020-01-15T10:30:00');
    expect(rows[0]![3]).toBeCloseTo(19.99);
    expect(rows[0]![4]).toBe(true);
    // Row 2: nulls preserved, bool false.
    expect(rows[1]![0]).toBeNull();
    expect(rows[1]![4]).toBe(false);
  });
});
