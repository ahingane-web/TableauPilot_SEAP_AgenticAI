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
