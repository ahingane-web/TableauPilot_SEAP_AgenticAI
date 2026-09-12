/** Shared XML helpers for the .twb authoring compiler. */
import type { DatasourceField } from '../types.js';
import type { TwbDataType } from './pill.js';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Map a Metadata API data type to a normalized .twb column datatype. */
export function twbDataType(field: DatasourceField | undefined): TwbDataType {
  const t = (field?.dataType ?? 'STRING').toUpperCase();
  if (['INTEGER', 'BIGINT'].includes(t)) return 'integer';
  if (['REAL', 'DECIMAL', 'FLOAT', 'DOUBLE', 'NUMBER'].includes(t)) return 'real';
  if (['DATE'].includes(t)) return 'date';
  if (['DATETIME', 'TIMESTAMP'].includes(t)) return 'datetime';
  if (['BOOLEAN'].includes(t)) return 'boolean';
  return 'string';
}

/** Tableau column local-name form: `[Field Name]`. */
export function localName(fieldName: string): string {
  return `[${fieldName}]`;
}

/** Tableau column local datatypes valid as a measure without coercion. */
const NUMERIC_TWB_TYPES = new Set<TwbDataType>(['integer', 'real']);

/**
 * Datatype to declare for a field used as a MEASURE. Tableau rejects a non-numeric
 * column declared as a measure ("can't interpret field as measure" — e.g. a boolean
 * like `[IsPriorityRecord]`, a string, or a date). Coerce any non-numeric type to
 * `real` so the data server aggregates it numerically (boolean true -> 1) rather than
 * failing the workbook load.
 */
export function measureDatatype(localType: TwbDataType): TwbDataType {
  return NUMERIC_TWB_TYPES.has(localType) ? localType : 'real';
}
