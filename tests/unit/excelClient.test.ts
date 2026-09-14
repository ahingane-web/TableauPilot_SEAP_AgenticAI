import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../../src/excel/excelClient.js';

/** Build an in-memory .xlsx buffer for round-trip parsing tests. */
async function makeWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const orders = wb.addWorksheet('Orders');
  orders.addRow(['Order ID', 'Sales', 'Quantity', 'Order Date', 'Returned']);
  orders.addRow(['CA-1', 12.5, 3, new Date(Date.UTC(2024, 0, 15)), true]);
  orders.addRow(['CA-2', 7, 1, new Date(Date.UTC(2024, 1, 2)), false]);

  // A sheet whose name + a header need sanitizing, plus an empty header cell.
  const region = wb.addWorksheet('APAC Region');
  region.addRow(['Region Name', '', 'Country/Region']);
  region.addRow(['West', 'x', 'US']);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

describe('parseWorkbook', () => {
  it('parses sheets, sanitizes names, infers types, and coerces rows', async () => {
    const { sheets } = await parseWorkbook(await makeWorkbook());
    expect(sheets.map((s) => s.id)).toEqual(['Orders', 'APAC_Region']);

    const orders = sheets[0]!;
    expect(orders.caption).toBe('Orders');
    expect(orders.columns.map((c) => c.name)).toEqual(['Order_ID', 'Sales', 'Quantity', 'Order_Date', 'Returned']);
    expect(orders.columns.map((c) => c.type)).toEqual(['string', 'real', 'integer', 'date', 'boolean']);
    // Original labels are preserved for display.
    expect(orders.columns[0]!.label).toBe('Order ID');

    // Rows are coerced: dates -> ISO YYYY-MM-DD, numbers/booleans as primitives.
    expect(orders.rows.length).toBe(2);
    expect(orders.rows[0]).toEqual(['CA-1', 12.5, 3, '2024-01-15', true]);
  });

  it('sanitizes sheet names and fills empty header cells with unique ids', async () => {
    const { sheets } = await parseWorkbook(await makeWorkbook());
    const region = sheets[1]!;
    expect(region.id).toBe('APAC_Region');
    expect(region.caption).toBe('APAC Region');
    // Empty header (2nd column) gets a generated identifier-safe name.
    expect(region.columns.map((c) => c.name)).toEqual(['Region_Name', 'Column_2', 'Country_Region']);
  });

  it('caps rows at the configured maximum', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Big');
    ws.addRow(['n']);
    for (let i = 0; i < 10; i++) ws.addRow([i]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const { sheets } = await parseWorkbook(buf, { maxRows: 4 });
    expect(sheets[0]!.rows.length).toBe(4);
  });
});
