/**
 * Published datasource metadata via the Tableau Metadata API (GraphQL).
 *
 * Fields (name, role, data type) are read live from the selected datasource. The
 * agent may ONLY plan against these real fields — nothing is invented. If the
 * Metadata API is unavailable on the site, we say so explicitly rather than
 * guessing field names.
 */
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { redactString } from '../../utils/redaction.js';
import type { FieldRole } from '../../schemas/common.js';
import type { TableauClient } from '../tableauClient.js';
import type { DatasourceField, DatasourceMetadata } from '../types.js';

const log = logger.child('datasource-metadata');

const NUMERIC_TYPES = new Set(['INTEGER', 'REAL', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'NUMBER']);
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);
/** A dimension whose name matches this is treated as a date even if typed STRING. */
const DATE_NAME_RE = /\b(date|datetime|timestamp)\b/i;

// NOTE: `DatasourceField` in the Metadata API does NOT expose `dataType`/`role`
// directly — it references an upstream field via `remoteField`. Selecting an
// invalid field on it makes the whole GraphQL query fail, so we read `remoteField`
// instead. `name`/`__typename` come from the base Field type for every field.
const METADATA_QUERY = `
query DatasourceFields($luid: String!) {
  publishedDatasources(filter: { luid: $luid }) {
    name
    fields {
      name
      __typename
      ... on ColumnField { dataType role }
      ... on CalculatedField { dataType role formula }
      ... on DatasourceField {
        remoteField {
          __typename
          ... on ColumnField { dataType role }
          ... on CalculatedField { dataType role formula }
        }
      }
    }
  }
}`.trim();

interface MetadataField {
  name?: string;
  __typename?: string;
  dataType?: string;
  role?: string;
  formula?: string;
  remoteField?: { __typename?: string; dataType?: string; role?: string; formula?: string };
}

interface MetadataResponse {
  data?: {
    publishedDatasources?: Array<{
      name?: string;
      fields?: MetadataField[];
    }>;
  };
  errors?: Array<{ message?: string }>;
}

function classifyRole(rawRole: string | undefined, dataType: string): FieldRole {
  if (rawRole === 'MEASURE') return 'measure';
  if (rawRole === 'DIMENSION') return 'dimension';
  // Infer when the Metadata API doesn't provide a role.
  return NUMERIC_TYPES.has(dataType.toUpperCase()) ? 'measure' : 'dimension';
}

export async function getDatasourceMetadata(
  client: TableauClient,
  datasourceId: string,
  datasourceName: string,
): Promise<DatasourceMetadata> {
  let response: MetadataResponse | undefined;
  let requestError: string | undefined;
  try {
    response = await client.metadataGraphql<MetadataResponse>(METADATA_QUERY, { luid: datasourceId });
  } catch (err) {
    requestError = err instanceof AppError ? err.message : redactString(String(err));
    log.warn('Metadata API request failed', { datasourceId, reason: requestError });
  }

  const gqlErrors = (response?.errors ?? []).map((e) => e.message).filter(Boolean) as string[];
  const ds = response?.data?.publishedDatasources?.[0];
  if (!ds || !ds.fields || ds.fields.length === 0 || gqlErrors.length) {
    const reason =
      requestError ??
      (gqlErrors.length
        ? `Metadata API GraphQL error: ${redactString(gqlErrors.join('; '))}`
        : 'The Metadata API returned no fields for this datasource (it may not be indexed yet, or the Metadata API is not enabled for this site).');
    log.warn('Metadata API returned no usable fields', { datasourceId, reason });
    return {
      datasourceId,
      datasourceName,
      fields: [],
      dimensions: [],
      measures: [],
      dates: [],
      metadataApiAvailable: false,
      unavailableReason: reason,
    };
  }

  const seen = new Set<string>();
  const fields: DatasourceField[] = [];
  for (const f of ds.fields) {
    const name = f.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // Federated (DatasourceField) fields carry their type on `remoteField`.
    let dataType = (f.dataType ?? f.remoteField?.dataType ?? 'STRING').toUpperCase();
    const rawRole = f.role ?? f.remoteField?.role;
    // A datasource-defined calculated field carries its formula; capturing it lets the
    // generator DEFINE the field locally in the workbook (with a unique internal name)
    // so the chart renders — rather than referencing an empty physical column (blank).
    const typename = f.__typename === 'DatasourceField' ? f.remoteField?.__typename : f.__typename;
    const formula = f.formula ?? f.remoteField?.formula;
    let isDate = DATE_TYPES.has(dataType);
    const role = classifyRole(rawRole, dataType);
    // Name-based date inference: many published datasources (federated/extract) don't
    // expose a proper date type via the Metadata API, so a date column comes back as
    // STRING. A DIMENSION whose name is clearly a date (e.g. "Order Date", "Ship Date")
    // is treated as a real date so trend charts get a continuous MONTH() axis.
    if (!isDate && role === 'dimension' && DATE_NAME_RE.test(name)) {
      dataType = 'DATE';
      isDate = true;
    }
    fields.push({
      name,
      dataType,
      role,
      isDate,
      fieldType: typename,
      ...(formula ? { formula } : {}),
    });
  }

  return {
    datasourceId,
    datasourceName: ds.name ?? datasourceName,
    fields,
    dimensions: fields.filter((f) => f.role === 'dimension'),
    measures: fields.filter((f) => f.role === 'measure'),
    dates: fields.filter((f) => f.isDate),
    metadataApiAvailable: true,
  };
}
