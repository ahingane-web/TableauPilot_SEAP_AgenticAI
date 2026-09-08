/**
 * DashboardPlan -> Tableau workbook XML (.twb) generator.
 *
 * This is the "Category A-gen" step of the hybrid strategy: a validated plan is
 * compiled into a well-formed .twb that references the LOCKED published datasource
 * (via a sqlproxy connection) and lays out worksheets + a dashboard. The workbook is
 * then published via the REST API to create a REAL dashboard in Tableau Cloud.
 *
 * Honesty note (see docs/authoring-limitations.md): programmatic .twb authoring
 * against an arbitrary published datasource is best-effort. The published-datasource
 * binding and fine visual tuning are completed/confirmed in the REAL Web Authoring
 * embed. Verification (REST) confirms the workbook/dashboard actually exists and is
 * published — it never claims pixel-perfect fidelity. Fields referenced here are
 * ALWAYS validated against live metadata beforehand, so no field is invented.
 */
import type { DashboardPlan } from '../../schemas/dashboardPlan.js';
import type { WorksheetSpec } from '../../schemas/worksheetSpec.js';
import type { DatasourceMetadata, DatasourceField } from '../types.js';

const WORKBOOK_VERSION = '18.1';
const DS_NAME = 'federated.tableaupilot';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Map a Metadata API data type to a .twb column datatype. */
function twbDataType(field: DatasourceField | undefined): string {
  const t = (field?.dataType ?? 'STRING').toUpperCase();
  if (['INTEGER', 'BIGINT'].includes(t)) return 'integer';
  if (['REAL', 'DECIMAL', 'FLOAT', 'DOUBLE', 'NUMBER'].includes(t)) return 'real';
  if (['DATE'].includes(t)) return 'date';
  if (['DATETIME', 'TIMESTAMP'].includes(t)) return 'datetime';
  if (['BOOLEAN'].includes(t)) return 'boolean';
  return 'string';
}

function localName(fieldName: string): string {
  // Tableau column local name form: [Field Name]
  return `[${fieldName}]`;
}

/** Collect every field referenced by the plan (for the datasource column list). */
function collectReferencedFields(plan: DashboardPlan): { dimensions: Set<string>; measures: Set<string> } {
  const dimensions = new Set<string>();
  const measures = new Set<string>();
  for (const ws of plan.worksheets) {
    ws.dimensions.forEach((d) => dimensions.add(d));
    ws.measures.forEach((m) => measures.add(m.field));
    if (ws.kpiMeasure) measures.add(ws.kpiMeasure.field);
    ws.filters.forEach((f) => dimensions.add(f.field));
  }
  for (const f of plan.filters) dimensions.add(f.field);
  return { dimensions, measures };
}

function renderColumns(plan: DashboardPlan, metadata: DatasourceMetadata): string {
  const byName = new Map(metadata.fields.map((f) => [f.name, f]));
  const { dimensions, measures } = collectReferencedFields(plan);
  const lines: string[] = [];

  for (const name of dimensions) {
    if (measures.has(name)) continue; // measure wins if referenced both ways
    const field = byName.get(name);
    const dt = twbDataType(field);
    lines.push(
      `      <column caption='${escapeXml(name)}' datatype='${dt}' name='${escapeXml(localName(name))}' role='dimension' type='nominal' />`,
    );
  }
  for (const name of measures) {
    const field = byName.get(name);
    const dt = twbDataType(field) === 'string' ? 'real' : twbDataType(field);
    lines.push(
      `      <column caption='${escapeXml(name)}' datatype='${dt}' name='${escapeXml(localName(name))}' role='measure' type='quantitative' />`,
    );
  }

  // Calculated fields become columns with a <calculation>.
  const calcs = [...plan.calculatedFields, ...plan.worksheets.flatMap((w) => w.calculations)];
  const seenCalc = new Set<string>();
  for (const calc of calcs) {
    if (seenCalc.has(calc.name)) continue;
    seenCalc.add(calc.name);
    const role = calc.role === 'dimension' ? 'dimension' : 'measure';
    const type = role === 'dimension' ? 'nominal' : 'quantitative';
    lines.push(
      `      <column caption='${escapeXml(calc.name)}' datatype='real' name='${escapeXml(localName(calc.name))}' role='${role}' type='${type}'>`,
    );
    lines.push(`        <calculation class='tableau' formula='${escapeXml(calc.formula)}' />`);
    lines.push(`      </column>`);
  }
  return lines.join('\n');
}

/**
 * Render the datasource element referencing the published datasource. The
 * sqlproxy connection points at the published datasource by its content URL; the
 * REST publish + Web Authoring embed finalize the binding on the server.
 */
function renderDatasource(plan: DashboardPlan, metadata: DatasourceMetadata): string {
  const caption = escapeXml(plan.datasource.datasourceName);
  const dbname = escapeXml(plan.datasource.contentUrl ?? plan.datasource.datasourceName);
  return [
    `  <datasources>`,
    `    <datasource caption='${caption}' inline='true' name='${DS_NAME}' version='${WORKBOOK_VERSION}'>`,
    `      <connection class='sqlproxy' dbname='${dbname}'>`,
    `        <relation name='${caption}' type='table' />`,
    `      </connection>`,
    renderColumns(plan, metadata),
    `    </datasource>`,
    `  </datasources>`,
  ].join('\n');
}

/** Build the rows/cols shelf expressions for a worksheet. */
function shelfExpr(fieldName: string, aggregate?: string): string {
  const inner = `[${DS_NAME}].${localName(fieldName)}`;
  if (aggregate && aggregate !== 'none') {
    const fn = aggregate.toUpperCase();
    return `[${DS_NAME}].[${fn.toLowerCase()}:${fieldName}:qk]`;
  }
  return inner;
}

function renderWorksheet(ws: WorksheetSpec, plan: DashboardPlan): string {
  const cols = ws.dimensions.map((d) => shelfExpr(d)).join('');
  const rows = (ws.measures.length ? ws.measures : ws.kpiMeasure ? [ws.kpiMeasure] : [])
    .map((m) => shelfExpr(m.field, m.aggregation))
    .join('');
  const datasourceDeps = [...ws.dimensions, ...ws.measures.map((m) => m.field)];
  const depColumns = datasourceDeps
    .map((f) => `          <column datatype='string' name='${escapeXml(localName(f))}' role='dimension' type='nominal' />`)
    .join('\n');

  return [
    `    <worksheet name='${escapeXml(ws.name)}'>`,
    `      <table>`,
    `        <view>`,
    `          <datasources>`,
    `            <datasource caption='${escapeXml(plan.datasource.datasourceName)}' name='${DS_NAME}' />`,
    `          </datasources>`,
    `          <datasource-dependencies datasource='${DS_NAME}'>`,
    depColumns,
    `          </datasource-dependencies>`,
    `        </view>`,
    `        <panes>`,
    `          <pane>`,
    `            <view>`,
    `              <breakdown value='auto' />`,
    `            </view>`,
    `            <mark class='${markClass(ws)}' />`,
    `          </pane>`,
    `        </panes>`,
    `        <rows>${escapeXml(rows)}</rows>`,
    `        <cols>${escapeXml(cols)}</cols>`,
    `      </table>`,
    `      <!-- chartType: ${escapeXml(ws.chartType)} -->`,
    `    </worksheet>`,
  ].join('\n');
}

function markClass(ws: WorksheetSpec): string {
  switch (ws.chartType) {
    case 'line':
    case 'area':
      return 'Line';
    case 'scatter':
      return 'Circle';
    case 'pie':
    case 'donut':
      return 'Pie';
    case 'text_table':
    case 'highlight_table':
    case 'kpi':
      return 'Text';
    case 'map':
    case 'symbol_map':
    case 'filled_map':
      return 'Automatic';
    default:
      return 'Bar';
  }
}

function renderDashboard(plan: DashboardPlan): string {
  const zones = plan.layout.items
    .map((item, i) => {
      const w = Math.floor((100000 / plan.layout.columns) * item.colSpan);
      const h = Math.floor(20000 * item.rowSpan);
      const x = Math.floor((100000 / plan.layout.columns) * item.col);
      const y = Math.floor(20000 * item.row);
      return `        <zone h='${h}' id='${i + 4}' w='${w}' x='${x}' y='${y}' name='${escapeXml(item.worksheet)}' />`;
    })
    .join('\n');
  return [
    `    <dashboard name='${escapeXml(plan.dashboardName)}'>`,
    `      <style />`,
    `      <size maxheight='${plan.layout.height}' maxwidth='${plan.layout.width}' minheight='${plan.layout.height}' minwidth='${plan.layout.width}' />`,
    `      <zones>`,
    `        <zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'>`,
    zones,
    `        </zone>`,
    `      </zones>`,
    `    </dashboard>`,
  ].join('\n');
}

/** Generate the full .twb XML string for a plan + live datasource metadata. */
export function generateTwb(plan: DashboardPlan, metadata: DatasourceMetadata): string {
  const worksheets = plan.worksheets.map((ws) => renderWorksheet(ws, plan)).join('\n');
  return [
    `<?xml version='1.0' encoding='utf-8' ?>`,
    `<!-- Generated by TableauPilot AI from an approved, Zod-validated DashboardPlan. -->`,
    `<workbook version='${WORKBOOK_VERSION}' xmlns:user='http://www.tableausoftware.com/xml/user'>`,
    renderDatasource(plan, metadata),
    `  <worksheets>`,
    worksheets,
    `  </worksheets>`,
    `  <dashboards>`,
    renderDashboard(plan),
    `  </dashboards>`,
    `  <windows>`,
    `    <window class='dashboard' name='${escapeXml(plan.dashboardName)}' />`,
    `  </windows>`,
    `</workbook>`,
  ].join('\n');
}
