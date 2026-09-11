/* eslint-disable no-console -- this is a dev-only CLI harness that reports via stdout. */
/**
 * Dev-only end-to-end generation harness.
 *
 * Builds a realistic multi-dashboard plan (4 KPIs incl. an already-aggregated SUM/SUM
 * calc, a parameter-driven Top-N bar, a monthly line, a detail crosstab, and an
 * apply-to-all filter) and runs the REAL `generateTwb`, then asserts — against the
 * ACTUAL generated XML, not a mock — that every one of the 8 reported points holds:
 *
 *   1. apply-to-all filter control appears on EVERY dashboard
 *   2. Top-N parameter control is placed + its ranking measure instance is declared
 *   3. a KPI row has exactly one cell per KPI (no extra containers)
 *   4. dashboard size propagates to every board
 *   5. no legend zones are emitted
 *   6. no empty/blank zones are emitted
 *   7. a detail sheet puts ALL fields (dims + measures) DISCRETE on Rows
 *   8. a monthly line uses continuous MONTH(Date) -> tmn:<field>:qk
 *
 * Plus: an already-aggregated calc measure is placed as AGG(field) (usr:...:qk), and
 * the whole workbook is well-formed (piped through `xmllint --noout` when available).
 *
 * Run:  npx tsx scripts/generateSample.ts
 * (No network, no secrets — pure deterministic generation.)
 */
import { spawnSync } from 'node:child_process';
import { DashboardPlanSchema, type DashboardPlan } from '../src/schemas/dashboardPlan.js';
import { generateTwb } from '../src/tableau/authoring/twbGenerator.js';
import { validatePlanFields } from '../src/validation/fieldValidation.js';
import type { DatasourceField, DatasourceMetadata } from '../src/tableau/types.js';

// ---- Fake-but-realistic live datasource metadata ----------------------------
function field(name: string, role: 'dimension' | 'measure', dataType: string, isDate = false): DatasourceField {
  return { name, role, dataType, isDate };
}
const fields: DatasourceField[] = [
  field('Order Date', 'dimension', 'DATE', true),
  field('Category', 'dimension', 'STRING'),
  field('Region', 'dimension', 'STRING'),
  field('Segment', 'dimension', 'STRING'),
  field('Customer Name', 'dimension', 'STRING'),
  field('Sales', 'measure', 'REAL'),
  field('Profit', 'measure', 'REAL'),
  field('Quantity', 'measure', 'INTEGER'),
  // A DATASOURCE-DEFINED calculated field (like the user's Superstore "Profit Margin %").
  // Referencing it must DEFINE it locally with its formula (a unique internal name) so the
  // chart renders — NOT leave it as an empty physical column (blank).
  { name: 'Profit Margin %', role: 'measure', dataType: 'REAL', isDate: false, fieldType: 'CalculatedField', formula: 'SUM([Profit])/SUM([Sales])' },
];
const metadata: DatasourceMetadata = {
  datasourceId: 'ds-1',
  datasourceName: 'Superstore',
  fields,
  dimensions: fields.filter((f) => f.role === 'dimension'),
  measures: fields.filter((f) => f.role === 'measure'),
  dates: fields.filter((f) => f.isDate),
  metadataApiAvailable: true,
};

// ---- A realistic multi-dashboard plan ---------------------------------------
const sizeFixed = { size: 'fixed' as const, width: 1300, height: 1700, columns: 4 };
const draft = {
  dashboardName: 'Executive Overview',
  datasource: { datasourceId: 'ds-1', datasourceName: 'Superstore', siteId: 'site-1', contentUrl: 'superstore' },
  calculatedFields: [
    // Already-aggregated: must be placed as AGG(field), NOT re-wrapped in SUM(...).
    { name: 'Profit Ratio', formula: 'SUM([Profit])/SUM([Sales])', referencedFields: ['Profit', 'Sales'], role: 'measure' as const },
  ],
  // Apply-to-all (global) filter: a control on EVERY board.
  filters: [
    { field: 'Region', operator: 'in' as const, values: ['East', 'West'], scope: 'all_worksheets' as const, showAsControl: true },
  ],
  worksheets: [
    { name: 'KPI Total Sales', chartType: 'kpi' as const, kpiMeasure: { field: 'Sales' } },
    { name: 'KPI Total Profit', chartType: 'kpi' as const, kpiMeasure: { field: 'Profit' } },
    { name: 'KPI Quantity', chartType: 'kpi' as const, kpiMeasure: { field: 'Quantity' } },
    // KPI over an ALREADY-AGGREGATED planner calc -> defined locally, User derivation.
    { name: 'KPI Profit Ratio', chartType: 'kpi' as const, kpiMeasure: { field: 'Profit Ratio' } },
    // KPI over a DATASOURCE-DEFINED calc field -> internalized + defined locally (renders).
    { name: 'KPI Margin', chartType: 'kpi' as const, kpiMeasure: { field: 'Profit Margin %' } },
    // Parameter-driven Top-N bar (ranked by Sales).
    {
      name: 'Top Categories',
      chartType: 'bar' as const,
      dimensions: ['Category'],
      measures: [{ field: 'Sales' }],
      filters: [
        {
          field: 'Category',
          operator: 'top_n' as const,
          topN: { n: 5, byMeasure: 'Sales', measureAggregation: 'sum' as const, direction: 'top' as const },
        },
      ],
    },
    // Monthly line -> continuous MONTH(Order Date).
    { name: 'Sales Trend', chartType: 'line' as const, dimensions: ['Order Date'], measures: [{ field: 'Sales' }] },
    // Detail crosstab -> ALL fields discrete on Rows.
    {
      name: 'Order Details',
      chartType: 'detail' as const,
      dimensions: ['Category', 'Region', 'Segment'],
      measures: [{ field: 'Sales' }, { field: 'Profit' }],
    },
  ],
  layout: {
    ...sizeFixed,
    items: [
      { worksheet: 'KPI Total Sales', row: 0, col: 0, kind: 'kpi' as const },
      { worksheet: 'KPI Total Profit', row: 0, col: 1, kind: 'kpi' as const },
      { worksheet: 'KPI Quantity', row: 0, col: 2, kind: 'kpi' as const },
      { worksheet: 'KPI Profit Ratio', row: 0, col: 3, kind: 'kpi' as const },
      { worksheet: 'Top Categories', row: 1, col: 0, colSpan: 2 },
      { worksheet: 'Sales Trend', row: 1, col: 2, colSpan: 2 },
    ],
  },
  dashboards: [
    {
      name: 'Executive Overview',
      ...sizeFixed,
      items: [
        { worksheet: 'KPI Total Sales', row: 0, col: 0, kind: 'kpi' as const },
        { worksheet: 'KPI Total Profit', row: 0, col: 1, kind: 'kpi' as const },
        { worksheet: 'KPI Quantity', row: 0, col: 2, kind: 'kpi' as const },
        { worksheet: 'KPI Profit Ratio', row: 0, col: 3, kind: 'kpi' as const },
        { worksheet: 'Top Categories', row: 1, col: 0, colSpan: 2 },
        { worksheet: 'Sales Trend', row: 1, col: 2, colSpan: 2 },
      ],
    },
    {
      name: 'Customer Analysis',
      ...sizeFixed,
      columns: 1,
      items: [{ worksheet: 'Top Categories', row: 0, col: 0 }],
    },
    {
      name: 'Order Details',
      ...sizeFixed,
      columns: 1,
      items: [{ worksheet: 'Order Details', row: 0, col: 0 }],
    },
  ],
  publishing: {
    siteId: 'site-1',
    projectId: 'proj-1',
    projectName: 'Sandbox',
    workbookName: 'sample-harness',
  },
};

const plan: DashboardPlan = DashboardPlanSchema.parse(draft);

// ---- Assertion helpers ------------------------------------------------------
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok  - ${msg}`);
  } else {
    console.error(`FAIL  - ${msg}`);
    failures += 1;
  }
}
/** Extract the XML of one <dashboard name='X'> ... </dashboard> block. */
function boardBlock(xml: string, name: string): string {
  const start = xml.indexOf(`<dashboard name='${name}'>`);
  if (start === -1) return '';
  const end = xml.indexOf('</dashboard>', start);
  return end === -1 ? '' : xml.slice(start, end);
}
/** Extract the XML of one <worksheet name='X'> ... </worksheet> block. */
function sheetBlock(xml: string, name: string): string {
  const start = xml.indexOf(`<worksheet name='${name}'>`);
  if (start === -1) return '';
  const end = xml.indexOf('</worksheet>', start);
  return end === -1 ? '' : xml.slice(start, end);
}
function count(hay: string, needle: RegExp): number {
  return (hay.match(needle) ?? []).length;
}

// ---- Run generation ---------------------------------------------------------
console.log('Validating plan fields...');
const validation = validatePlanFields(plan, metadata);
assert(validation.valid, `plan validates against metadata (errors: ${JSON.stringify(validation.errors)})`);

console.log('Generating .twb...');
const twb = generateTwb(plan, metadata, { serverHost: 'prod-in-a.online.tableau.com' });

const boards = ['Executive Overview', 'Customer Analysis', 'Order Details'];
const regionRef = "[sqlproxy.tableaupilot].[none:Region:nk]";

console.log('\n[1] apply-to-all filter control on EVERY board');
for (const b of boards) {
  const block = boardBlock(twb, b);
  assert(
    block.includes(`type-v2='filter'`) && block.includes(`param='${regionRef}'`),
    `board "${b}" has the Region filter control`,
  );
}

console.log('\n[2] Top-N parameter control + ranking measure instance');
const topSheet = sheetBlock(twb, 'Top Categories');
assert(topSheet.includes(`user:ui-top-by-field='true'`), 'Top Categories has a Top-N groupfilter');
assert(/count='\[Parameters\]\.\[Parameter \d+\]'/.test(topSheet), 'Top-N count references a Parameter');
assert(topSheet.includes(`name='[sum:Sales:qk]'`), 'ranking measure column-INSTANCE [sum:Sales:qk] is declared');
assert(
  boardBlock(twb, 'Executive Overview').includes(`type-v2='paramctrl'`) &&
    boardBlock(twb, 'Customer Analysis').includes(`type-v2='paramctrl'`),
  'Top-N paramctrl appears on the boards hosting the chart',
);
assert(!boardBlock(twb, 'Order Details').includes(`type-v2='paramctrl'`), 'no dead paramctrl on the Details board');
// The Top-N chart sorts its ranked dimension by the ranking measure (sample parity).
assert(
  /<shelf-sort-v2 [^>]*measure-to-sort-by='\[sqlproxy\.tableaupilot\]\.\[sum:Sales:qk\]'[^>]*\/>/.test(topSheet),
  'Top Categories has a <shelf-sort-v2> ranking by SUM(Sales)',
);
assert(topSheet.includes(`user:ui-manual-selection-is-empty='true'`), 'Top-N level-members carries ui-manual-selection-is-empty');
// The SAME parameter drives the filter count AND the placed control (no dead duplicate).
const countRef = /count='(\[Parameters\]\.\[Parameter \d+\])'/.exec(topSheet)?.[1];
const ctrlRef = /type-v2='paramctrl'[^>]*param='(\[Parameters\]\.\[Parameter \d+\])'|param='(\[Parameters\]\.\[Parameter \d+\])'[^>]*type-v2='paramctrl'/.exec(
  boardBlock(twb, 'Executive Overview'),
);
const placedParam = ctrlRef?.[1] ?? ctrlRef?.[2];
assert(!!countRef && countRef === placedParam, `Top-N count param (${countRef}) is the one shown as a control (${placedParam})`);
assert(count(boardBlock(twb, 'Executive Overview'), /type-v2='paramctrl'/g) === 1, 'exactly one paramctrl on the board');

console.log('\n[3] KPI row has exactly one cell per KPI (4), all on ONE row');
const overview = boardBlock(twb, 'Executive Overview');
assert(count(overview, /show-title='false'/g) === 4, 'Executive Overview has exactly 4 KPI cells');
// All KPI cards live in a SINGLE pinned scorecard strip.
assert(count(overview, /fixed-size='130'/g) === 1, 'exactly one fixed-size KPI row (all KPIs on one row)');

console.log('\n[4] dashboard size propagates to every board');
for (const b of boards) {
  assert(
    boardBlock(twb, b).includes(`maxheight='1700' maxwidth='1300' minheight='1700' minwidth='1300' sizing-mode='fixed'`),
    `board "${b}" is fixed 1300x1700`,
  );
}

console.log('\n[5] no legend zones');
assert(count(twb, /type-v2='(color|size|shape)'/g) === 0, 'zero legend zones emitted');

console.log('\n[6] no empty/blank zones');
assert(count(twb, /type-v2='empty'/g) === 0, 'zero empty zones emitted');

console.log('\n[7] detail sheet: ALL fields discrete on Rows');
const detail = sheetBlock(twb, 'Order Details');
const rowsMatch = /<rows>([\s\S]*?)<\/rows>/.exec(detail);
const detailRows = rowsMatch?.[1] ?? '';
assert(detailRows.includes('none:Category:nk'), 'detail Rows includes discrete Category');
assert(detailRows.includes('sum:Sales:ok') && detailRows.includes('sum:Profit:ok'), 'detail Rows measures are DISCRETE (ok, not qk)');
assert(!/:qk\]/.test(detailRows), 'detail Rows has no continuous (qk) pills');
assert((detail.match(/<cols><\/cols>/) ?? []).length === 1, 'detail Cols shelf is empty');

console.log('\n[8] monthly line uses continuous MONTH(Order Date)');
const trend = sheetBlock(twb, 'Sales Trend');
assert(trend.includes('tmn:Order Date:qk'), 'Sales Trend uses continuous MONTH-Trunc (tmn:Order Date:qk)');

console.log('\n[+] calculated fields are defined LOCALLY with a unique internal name (no blanks)');
/** Find a locally-defined calc's internal name (Calculation_N) by its display caption. */
function calcInternalName(xml: string, caption: string): string | undefined {
  const re = new RegExp(`<column [^>]*caption='${caption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^>]*name='\\[(Calculation_\\d+)\\]'`);
  return re.exec(xml)?.[1];
}
// Planner calc "Profit Ratio" (already aggregated).
const ratioInternal = calcInternalName(twb, 'Profit Ratio');
assert(!!ratioInternal, `planner calc "Profit Ratio" defined with a unique internal name (${ratioInternal ?? 'MISSING'})`);
assert(
  twb.includes(`caption='Profit Ratio'`) && twb.includes(`formula='SUM([Profit])/SUM([Sales])'`),
  'Profit Ratio keeps its display caption + formula',
);
const ratio = sheetBlock(twb, 'KPI Profit Ratio');
assert(!!ratioInternal && ratio.includes(`usr:${ratioInternal}:qk`), 'KPI references Profit Ratio by internal name, User derivation');
assert(!/sum:Calculation_\d+/.test(ratio), 'Profit Ratio is NOT re-wrapped in SUM(...)');

// DATASOURCE-DEFINED calc "Profit Margin %": must be internalized + defined locally (renders).
const marginInternal = calcInternalName(twb, 'Profit Margin %');
assert(!!marginInternal, `datasource calc "Profit Margin %" is defined LOCALLY with a formula (${marginInternal ?? 'MISSING — would render BLANK'})`);
const margin = sheetBlock(twb, 'KPI Margin');
assert(!!marginInternal && margin.includes(`usr:${marginInternal}:qk`), 'KPI Margin references the internalized calc, not an empty column');
// It must NOT be emitted as an empty physical column / physical metadata-record (the blank bug).
assert(!/<remote-name>Profit Margin %<\/remote-name>/.test(twb), '"Profit Margin %" is not a physical remote column (no blank)');
assert(!/<column caption='Profit Margin %'[^>]*\/>/.test(twb), '"Profit Margin %" is never an empty (formula-less) column');

// No referenced calc is left as an empty base column (every Calculation_N column has a body).
assert(!/<column [^>]*name='\[Calculation_\d+\]'[^>]*\/>/.test(twb), 'no calc is emitted as an empty self-closing column');
// Each worksheet that uses a calc redeclares it WITH its formula (not a plain stub).
assert(
  ratio.includes(`caption='Profit Ratio'`) && ratio.includes('<calculation class=\'tableau\''),
  'worksheet redeclares the calc column WITH its <calculation> (no shadowing stub)',
);

console.log('\n[well-formed] xmllint --noout');
const lint = spawnSync('xmllint', ['--noout', '-'], { input: twb, encoding: 'utf8' });
if (lint.error && (lint.error as NodeJS.ErrnoException).code === 'ENOENT') {
  console.log('  skip - xmllint not installed');
} else {
  assert(lint.status === 0, `workbook is well-formed XML (${lint.stderr?.trim() || 'ok'})`);
}

console.log('');
if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('All harness assertions passed.');
