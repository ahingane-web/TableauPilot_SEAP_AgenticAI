import { describe, it, expect } from 'vitest';
import { getDatasourceMetadata } from '../../src/tableau/datasources/index.js';
import type { TableauClient } from '../../src/tableau/tableauClient.js';

/**
 * A published datasource whose date columns are reported as STRING by the Metadata API
 * (common for federated/extract sources). A dimension named like a date must still be
 * classified as a real date so trend charts get a continuous MONTH() axis.
 */
function fakeClient(fields: { name: string; dataType?: string; role?: string }[]): TableauClient {
  return {
    async metadataGraphql() {
      return { data: { publishedDatasources: [{ name: 'DS', fields }] } };
    },
  } as unknown as TableauClient;
}

describe('metadata date-name inference', () => {
  it('treats a STRING-typed "Order Date" / "Ship Date" dimension as a date', async () => {
    const client = fakeClient([
      { name: 'Order Date', dataType: 'STRING', role: 'DIMENSION' },
      { name: 'Ship Date', dataType: 'STRING', role: 'DIMENSION' },
      { name: 'Category', dataType: 'STRING', role: 'DIMENSION' },
      { name: 'Sales', dataType: 'REAL', role: 'MEASURE' },
      { name: 'Candidate', dataType: 'STRING', role: 'DIMENSION' }, // must NOT be a date
    ]);
    const md = await getDatasourceMetadata(client, 'ds-1', 'DS');
    const byName = new Map(md.fields.map((f) => [f.name, f]));
    expect(byName.get('Order Date')?.isDate).toBe(true);
    expect(byName.get('Order Date')?.dataType).toBe('DATE');
    expect(byName.get('Ship Date')?.isDate).toBe(true);
    // A regular category and a look-alike ("Candidate") stay non-date.
    expect(byName.get('Category')?.isDate).toBe(false);
    expect(byName.get('Candidate')?.isDate).toBe(false);
    // Sales stays a measure.
    expect(byName.get('Sales')?.role).toBe('measure');
  });
});
