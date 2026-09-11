/**
 * Shared test fixtures: a realistic, schema-valid DashboardPlan and matching live
 * datasource metadata. Field names here intentionally line up so field validation
 * passes; individual tests mutate copies to exercise failure paths.
 */
import type { DashboardPlan } from '../../src/schemas/dashboardPlan.js';
import type { DatasourceMetadata, DatasourceField } from '../../src/tableau/types.js';

export const SITE_ID = 'site-1';
export const DS_ID = 'ds-1';
export const PROJECT_ID = 'proj-1';

function field(name: string, role: 'dimension' | 'measure', dataType: string, isDate = false): DatasourceField {
  return { name, role, dataType, isDate, fieldType: 'ColumnField' };
}

export const metadata: DatasourceMetadata = {
  datasourceId: DS_ID,
  datasourceName: 'Superstore',
  metadataApiAvailable: true,
  fields: [
    field('Category', 'dimension', 'STRING'),
    field('Region', 'dimension', 'STRING'),
    field('Order Date', 'dimension', 'DATE', true),
    field('Sales', 'measure', 'REAL'),
    field('Profit', 'measure', 'REAL'),
    field('Quantity', 'measure', 'INTEGER'),
  ],
  get dimensions() {
    return this.fields.filter((f) => f.role === 'dimension' && !f.isDate);
  },
  get measures() {
    return this.fields.filter((f) => f.role === 'measure');
  },
  get dates() {
    return this.fields.filter((f) => f.isDate);
  },
};

export function makePlan(): DashboardPlan {
  return {
    dashboardName: 'Sales Overview',
    description: 'Sales & profit by category and region',
    datasource: {
      datasourceId: DS_ID,
      datasourceName: 'Superstore',
      siteId: SITE_ID,
      contentUrl: 'superstore',
    },
    worksheets: [
      {
        name: 'Sales by Category',
        chartType: 'bar',
        dimensions: ['Category'],
        measures: [{ field: 'Sales', aggregation: 'sum' }],
        filters: [],
        calculations: [],
      },
      {
        name: 'Profit Ratio',
        chartType: 'kpi',
        dimensions: [],
        measures: [],
        filters: [],
        calculations: [
          {
            name: 'Profit Ratio',
            formula: 'SUM([Profit]) / SUM([Sales])',
            referencedFields: ['Profit', 'Sales'],
            role: 'measure',
          },
        ],
        kpiMeasure: { field: 'Profit', aggregation: 'sum' },
      },
    ],
    filters: [{ field: 'Region', operator: 'in', values: ['East', 'West'], scope: 'all_worksheets', showAsControl: true }],
    calculatedFields: [],
    parameters: [],
    actions: [],
    dashboards: [],
    layout: {
      size: 'fixed',
      width: 1200,
      height: 800,
      columns: 4,
      items: [
        { worksheet: 'Sales by Category', row: 0, col: 0, rowSpan: 2, colSpan: 3, kind: 'chart' },
        { worksheet: 'Profit Ratio', row: 0, col: 3, rowSpan: 1, colSpan: 1, kind: 'kpi' },
      ],
    },
    publishing: {
      siteId: SITE_ID,
      projectId: PROJECT_ID,
      projectName: 'Sales',
      workbookName: 'Sales Overview',
      overwrite: false,
      showTabs: true,
      mode: 'new_workbook',
    },
  };
}
