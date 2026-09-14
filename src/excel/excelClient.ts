/**
 * Excel connector — workbook parsing.
 *
 * Reads an uploaded `.xlsx` (via the `exceljs` library) and turns each worksheet into a
 * connector "table" analogous to a Salesforce object: a list of typed columns plus the
 * row data. Sheet and column names are sanitized to identifier-safe, unique names so they
 * can flow through the SAME deterministic `.tds`/`.hyper` pipeline the Salesforce connector
 * uses (`tdsGenerator` helpers filter to `[A-Za-z][A-Za-z0-9_]*`, and the Hyper sidecar
 * names tables `Extract."<name>"`). The original worksheet/column names are preserved as
 * `caption`/`label` for display.
 *
 * This module NEVER talks to Tableau or Salesforce; it only parses bytes in memory.
 */
import ExcelJS from 'exceljs';

/** Inferred column category (mirrors the Tableau/`TwbType` families). */
export type ExcelColumnType = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

/** One parsed column: identifier-safe name + original label + inferred type. */
export interface ExcelColumn {
  /** Sanitized, unique, identifier-safe column name (the Tableau/Hyper field name). */
  name: string;
  /** Original header label from the worksheet (for display). */
  label: string;
  /** Inferred column type. */
  type: ExcelColumnType;
}

/** One parsed worksheet: identifier-safe id + caption + columns + coerced rows. */
export interface ExcelSheet {
  /** Sanitized, unique, identifier-safe sheet id (the extract/Hyper table name). */
  id: string;
  /** Original worksheet name (caption shown to the user). */
  caption: string;
  /** Column schema (order defines row-array alignment). */
  columns: ExcelColumn[];
  /**
   * Rows aligned to `columns` order, coerced/serialized for the Hyper sidecar:
   * numbers as JS numbers, booleans as booleans, dates as ISO `YYYY-MM-DD`, datetimes as
   * ISO `YYYY-MM-DDTHH:MM:SS`, everything else as strings; empty cells become `null`.
   */
  rows: unknown[][];
}

export interface ParsedWorkbook {
  sheets: ExcelSheet[];
}

/** How many non-empty cells to sample per column when inferring its type. */
const TYPE_SAMPLE_LIMIT = 500;

/** Unwrap an exceljs cell value into its effective JS primitive/Date. */
function effectiveValue(v: unknown): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return effectiveValue(o.result); // formula cell
    if ('text' in o) return o.text; // hyperlink cell
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    }
    if ('error' in o) return null;
    return null;
  }
  return v;
}

/** Classify a single effective value, or `null` when it carries no type signal. */
function classify(value: unknown): ExcelColumnType | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const hasTime =
      value.getUTCHours() !== 0 ||
      value.getUTCMinutes() !== 0 ||
      value.getUTCSeconds() !== 0 ||
      value.getUTCMilliseconds() !== 0;
    return hasTime ? 'datetime' : 'date';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') {
    return value.trim() === '' ? null : 'string';
  }
  return 'string';
}

/** Combine two column-type observations into their least-common type. */
function combine(a: ExcelColumnType, b: ExcelColumnType): ExcelColumnType {
  if (a === b) return a;
  const numeric = (t: ExcelColumnType) => t === 'integer' || t === 'real';
  const temporal = (t: ExcelColumnType) => t === 'date' || t === 'datetime';
  if (numeric(a) && numeric(b)) return 'real'; // integer + real -> real
  if (temporal(a) && temporal(b)) return 'datetime'; // date + datetime -> datetime
  return 'string'; // any cross-family mix falls back to text
}

/**
 * Turn an arbitrary label into a unique, identifier-safe name (`[A-Za-z][A-Za-z0-9_]*`)
 * so it survives the Salesforce-grade `.tds`/`.hyper` pipeline. Original labels are kept
 * separately for display.
 */
function toSafeIdentifier(raw: string, prefix: string, used: Set<string>): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_');
  if (!/^[A-Za-z]/.test(s)) s = prefix + s;
  if (!s) s = prefix;
  let candidate = s;
  let n = 2;
  while (used.has(candidate)) candidate = `${s}_${n++}`;
  used.add(candidate);
  return candidate;
}

/** Coerce an effective value into the serialized form expected by the Hyper sidecar. */
function coerce(value: unknown, type: ExcelColumnType): unknown {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  switch (type) {
    case 'integer':
    case 'real': {
      const n = typeof value === 'number' ? value : Number(String(value));
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return true;
      if (['false', '0', 'no'].includes(s)) return false;
      return null;
    }
    case 'date':
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    case 'datetime':
      return value instanceof Date ? value.toISOString().slice(0, 19) : String(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * Parse an `.xlsx`/`.xlsm` buffer into typed, identifier-safe sheets ready for the extract
 * pipeline. Worksheets with no header row are skipped. Rows are capped at `opts.maxRows`.
 */
export async function parseWorkbook(buffer: Buffer, opts: { maxRows?: number } = {}): Promise<ParsedWorkbook> {
  const maxRows = opts.maxRows ?? 100000;
  const wb = new ExcelJS.Workbook();
  // `Buffer.from(arrayBuffer)` widens to `Buffer<ArrayBufferLike>` under @types/node v22,
  // which the exceljs `load(buffer: Buffer)` signature rejects; cast to its exact param type.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);

  const usedSheetIds = new Set<string>();
  const sheets: ExcelSheet[] = [];

  for (const ws of wb.worksheets) {
    // Skip hidden/very-hidden worksheets and truly empty ones.
    if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;
    const headerRow = ws.getRow(1);
    let lastCol = 0;
    headerRow.eachCell({ includeEmpty: false }, (_cell, col) => {
      if (col > lastCol) lastCol = col;
    });
    if (lastCol === 0) continue; // no header -> not a usable table

    // Column identity: sanitized unique name + original label.
    const usedColNames = new Set<string>();
    const rawLabels: string[] = [];
    for (let c = 1; c <= lastCol; c++) {
      const raw = String(effectiveValue(headerRow.getCell(c).value) ?? '').trim();
      rawLabels.push(raw || `Column ${c}`);
    }
    const names = rawLabels.map((label) => toSafeIdentifier(label, 'F', usedColNames));

    // Type inference: sample non-empty values per column.
    const observed: Array<ExcelColumnType | null> = new Array(lastCol).fill(null);
    const sampleCounts = new Array(lastCol).fill(0);
    const lastRow = ws.rowCount;
    for (let r = 2; r <= lastRow; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= lastCol; c++) {
        if (sampleCounts[c - 1] >= TYPE_SAMPLE_LIMIT) continue;
        const t = classify(effectiveValue(row.getCell(c).value));
        if (!t) continue;
        sampleCounts[c - 1] += 1;
        observed[c - 1] = observed[c - 1] == null ? t : combine(observed[c - 1] as ExcelColumnType, t);
      }
    }
    const columns: ExcelColumn[] = names.map((name, i) => ({
      name,
      label: rawLabels[i]!,
      type: (observed[i] ?? 'string') as ExcelColumnType,
    }));

    // Row data (coerced), capped and skipping fully-empty rows.
    const rows: unknown[][] = [];
    for (let r = 2; r <= lastRow && rows.length < maxRows; r++) {
      const row = ws.getRow(r);
      const values: unknown[] = [];
      let allNull = true;
      for (let c = 1; c <= lastCol; c++) {
        const v = coerce(effectiveValue(row.getCell(c).value), columns[c - 1]!.type);
        if (v != null) allNull = false;
        values.push(v);
      }
      if (allNull) continue;
      rows.push(values);
    }

    const id = toSafeIdentifier(ws.name, 'Sheet', usedSheetIds);
    sheets.push({ id, caption: ws.name, columns, rows });
  }

  return { sheets };
}
