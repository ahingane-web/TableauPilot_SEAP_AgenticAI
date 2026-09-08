/**
 * Published datasource metadata via the Tableau Metadata API (GraphQL).
 *
 * Fields (name, role, data type) are read live from the selected datasource. The
 * agent may ONLY plan against these real fields — nothing is invented. If the
 * Metadata API is unavailable on the site, we say so explicitly rather than
 * guessing field names.
 */
import { logger } from '../../utils/logger.js';
import type { FieldRole } from '../../schemas/common.js';
import type { TableauClient } from '../tableauClient.js';
import type { DatasourceField, DatasourceMetadata } from '../types.js';

const log = logger.child('datasource-metadata');

const NUMERIC_TYPES = new Set(['INTEGER', 'REAL', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'NUMBER']);
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);

const METADATA_QUERY = `
query DatasourceFields($luid: String!) {
  publishedDatasources(filter: { luid: $luid }) {
    name
    fields {
      name
      __typename
      ... on ColumnField { dataType role }
      ... on CalculatedField { dataType role }
      ... on DatasourceField { dataType }
    }
  }
}`.trim();

interface MetadataResponse {
  data?: {
    publishedDatasources?: Array<{
      name?: string;
      fields?: Array<{ name?: string; __typename?: string; dataType?: string; role?: string }>;
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
  try {
    response = await client.metadataGraphql<MetadataResponse>(METADATA_QUERY, { luid: datasourceId });
  } catch {
    log.warn('Metadata API request failed', { datasourceId });
  }

  const ds = response?.data?.publishedDatasources?.[0];
  if (!ds || !ds.fields || response?.errors?.length) {
    log.warn('Metadata API returned no fields', { datasourceId, hasErrors: Boolean(response?.errors?.length) });
    return {
      datasourceId,
      datasourceName,
      fields: [],
      dimensions: [],
      measures: [],
      dates: [],
      metadataApiAvailable: false,
    };
  }

  const seen = new Set<string>();
  const fields: DatasourceField[] = [];
  for (const f of ds.fields) {
    const name = f.name?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const dataType = (f.dataType ?? 'STRING').toUpperCase();
    const isDate = DATE_TYPES.has(dataType);
    fields.push({
      name,
      dataType,
      role: classifyRole(f.role, dataType),
      isDate,
      fieldType: f.__typename,
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
