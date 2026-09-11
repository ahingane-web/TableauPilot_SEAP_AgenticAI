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
import { randomUUID } from 'node:crypto';
import type { DashboardPlan, DashboardSpec } from '../../schemas/dashboardPlan.js';
import type { DashboardActionSpec } from '../../schemas/dashboardActionSpec.js';
import type { WorksheetSpec } from '../../schemas/worksheetSpec.js';
import type { FilterSpec } from '../../schemas/filterSpec.js';
import type { ParameterSpec } from '../../schemas/parameterSpec.js';
import type { DatasourceMetadata } from '../types.js';
import { escapeXml, twbDataType, localName } from './xml.js';
import { renderWorksheet, type AppliedFilter } from './worksheet.js';
import { resolveFilter } from './filters.js';
import { resolveParameters, renderParametersDatasource, type ResolvedParameter } from './parameters.js';
import {
  internalizeCalcs,
  buildCalcColumnXml,
  buildCalcMetadataRecord,
  calcFormulaDependencies,
  type LocalCalc,
} from './calcFields.js';

// Re-exported for callers/tests that imported it from here historically.
export { escapeXml };

const WORKBOOK_VERSION = '18.1';
// A workbook that references a PUBLISHED datasource connects to it through Tableau's data
// server via a `sqlproxy` connection; the datasource's internal name is `sqlproxy.<id>`
// (verified against a real workbook built on a published datasource). Worksheet field
// references resolve against this name, e.g. `[sqlproxy.tableaupilot].[none:Category:nk]`.
const DS_NAME = 'sqlproxy.tableaupilot';

/** A worksheet placed on the dashboard grid (subset of the plan's layout item). */
interface PlacedItem {
  worksheet: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/**
 * Collect every PHYSICAL datasource field the plan references (for the datasource column
 * list + metadata-records). Calculated fields are excluded — they are defined separately as
 * local `<calculation>` columns — but the physical fields their FORMULAS reference are
 * included, so a calc's dependencies are always declared.
 */
function collectReferencedFields(
  plan: DashboardPlan,
  metadata: DatasourceMetadata,
  calcs: LocalCalc[],
): { dimensions: Set<string>; measures: Set<string> } {
  const calcKeys = new Set(calcs.map((c) => normalizeFieldKey(c.internalName)));
  const dimensions = new Set<string>();
  const measures = new Set<string>();
  for (const ws of plan.worksheets) {
    ws.dimensions.forEach((d) => dimensions.add(d));
    ws.measures.forEach((m) => measures.add(m.field));
    if (ws.kpiMeasure) measures.add(ws.kpiMeasure.field);
    ws.filters.forEach((f) => dimensions.add(f.field));
  }
  for (const f of plan.filters) dimensions.add(f.field);
  // Physical fields referenced by calc formulas must be declared too.
  const deps = calcFormulaDependencies(calcs, metadata);
  deps.dimensions.forEach((d) => dimensions.add(d));
  deps.measures.forEach((m) => measures.add(m));
  // Never emit a calc's internal name as a plain physical column.
  for (const n of [...dimensions]) if (calcKeys.has(normalizeFieldKey(n))) dimensions.delete(n);
  for (const n of [...measures]) if (calcKeys.has(normalizeFieldKey(n))) measures.delete(n);
  return { dimensions, measures };
}

function renderColumns(plan: DashboardPlan, metadata: DatasourceMetadata, calcs: LocalCalc[]): string {
  const byName = new Map(metadata.fields.map((f) => [f.name, f]));
  const { dimensions, measures } = collectReferencedFields(plan, metadata, calcs);
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

  // Calculated fields: defined LOCALLY with a unique internal name + their formula, so they
  // never collide with a datasource field (which would blank the chart) and always render.
  for (const calc of calcs) {
    lines.push(buildCalcColumnXml(calc, '      '));
  }
  return lines.join('\n');
}

/**
 * Render the datasource element referencing the published datasource.
 *
 * CRITICAL: a workbook that uses a *published* datasource must carry a
 * <repository-location> element. That element is what tells Tableau the
 * datasource lives in the site's content repository (path /t/<site>/datasources)
 * and must be resolved server-side. Without it, Tableau treats the sqlproxy
 * `dbname` as a local file path and fails to load the workbook with
 * "Unable to connect to the file '<name>'".
 *
 * The `id` is the datasource's content URL (its addressable slug on the site);
 * `site` is the site content URL; `revision` 1.0 asks for the latest.
 */
/** OLE DB `remote-type` code for a Tableau local datatype (as Tableau's data server emits). */
function remoteTypeCode(localType: string): string {
  switch (localType) {
    case 'integer':
      return '20'; // DBTYPE_I8
    case 'real':
      return '5'; // DBTYPE_R8
    case 'date':
      return '7'; // DBTYPE_DATE
    case 'datetime':
      return '135'; // DBTYPE_DBTIMESTAMP
    case 'boolean':
      return '11'; // DBTYPE_BOOL
    default:
      return '130'; // DBTYPE_WSTR (string)
  }
}

/** The default aggregation Tableau records for a field in metadata-records. */
function metadataAggregation(role: 'dimension' | 'measure', localType: string): string {
  if (role === 'measure') return 'Sum';
  if (localType === 'date' || localType === 'datetime') return 'Year';
  return 'Count';
}

/**
 * Emit one <metadata-record> per referenced field, describing the data server's schema
 * (remote-name/type + local mapping). A real published-datasource workbook carries these;
 * `parent-name` is always `[sqlproxy]` for a data-server (sqlproxy) connection.
 */
function renderMetadataRecords(plan: DashboardPlan, metadata: DatasourceMetadata, calcs: LocalCalc[]): string {
  const byName = new Map(metadata.fields.map((f) => [f.name, f]));
  const { dimensions, measures } = collectReferencedFields(plan, metadata, calcs);
  const entries: { name: string; role: 'dimension' | 'measure' }[] = [];
  for (const name of dimensions) if (!measures.has(name)) entries.push({ name, role: 'dimension' });
  for (const name of measures) entries.push({ name, role: 'measure' });

  const physical = entries.map(({ name, role }, i) => {
    const field = byName.get(name);
    let localType = twbDataType(field);
    if (role === 'measure' && localType === 'string') localType = 'real';
    const remote = escapeXml(name);
    return [
      `        <metadata-record class='column'>`,
      `          <remote-name>${remote}</remote-name>`,
      `          <remote-type>${remoteTypeCode(localType)}</remote-type>`,
      `          <local-name>${escapeXml(localName(name))}</local-name>`,
      `          <parent-name>[sqlproxy]</parent-name>`,
      `          <remote-alias>${remote}</remote-alias>`,
      `          <ordinal>${i + 1}</ordinal>`,
      `          <local-type>${localType}</local-type>`,
      `          <aggregation>${metadataAggregation(role, localType)}</aggregation>`,
      `          <contains-null>true</contains-null>`,
      `        </metadata-record>`,
    ].join('\n');
  });
  // Calculated fields get a calc-style record (remote-type -1 + formula attribute).
  const calcRecords = calcs.map((c, i) => buildCalcMetadataRecord(c, entries.length + i + 1));
  return [...physical, ...calcRecords].join('\n');
}

/**
 * Render the datasource block that references the locked PUBLISHED datasource.
 *
 * Verified against a real workbook built on a published datasource: the workbook connects
 * through Tableau's DATA SERVER via a `class='sqlproxy'` connection — there is NO
 * <repository-location>. The connection carries the pod's data-server host (`server`), the
 * datasource id (`dbname`), and fixed data-server attributes (`directory='/dataserver'`,
 * `channel='https'`, `port='443'`). A `<relation type='collection'>` and per-field
 * `<metadata-records>` describe the schema.
 */
function renderDatasource(
  plan: DashboardPlan,
  metadata: DatasourceMetadata,
  calcs: LocalCalc[],
  serverHost?: string,
): string {
  const caption = escapeXml(plan.datasource.datasourceName);
  // The published-datasource id the data server resolves (name === contentUrl on Cloud).
  const dsId = plan.datasource.contentUrl ?? plan.datasource.datasourceName;
  const dbname = escapeXml(dsId);
  const server = escapeXml(serverHost ?? '');

  const connectionAttrs =
    `channel='https'` +
    ` class='sqlproxy'` +
    ` dbname='${dbname}'` +
    ` directory='/dataserver'` +
    ` local-dataserver=''` +
    ` port='443'` +
    ` server='${server}'` +
    ` username=''`;

  return [
    `  <datasources>`,
    `    <datasource caption='${caption}' inline='true' name='${DS_NAME}' version='${WORKBOOK_VERSION}'>`,
    `      <connection ${connectionAttrs}>`,
    `        <relation type='collection'>`,
    `          <relation name='sqlproxy' table='[sqlproxy]' type='table' />`,
    `        </relation>`,
        `        <metadata-records>`,
    renderMetadataRecords(plan, metadata, calcs),
        `        </metadata-records>`,
    `      </connection>`,
    renderColumns(plan, metadata, calcs),
    `    </datasource>`,
    `  </datasources>`,
  ].join('\n');
}

/**
 * Build a map from each worksheet's plan name to a FINAL name that is unique among
 * worksheets AND distinct from the dashboard name.
 *
 * Tableau resolves dashboard-zone references and window references by name. If a
 * worksheet shares its name with the dashboard (common when the model produces a
 * single-sheet dashboard), the zone reference resolves to the DASHBOARD window and
 * Tableau rejects the workbook with "window reference expected to be a worksheet but
 * resolves to a different window type" (error 400011). Disambiguating names fixes it.
 */
function buildWorksheetNameMap(worksheets: WorksheetSpec[], dashboardName: string): Map<string, string> {
  const map = new Map<string, string>();
  const usedLower = new Set<string>([dashboardName.trim().toLowerCase()]);
  for (const ws of worksheets) {
    let base = ws.name.trim() || 'Sheet';
    if (base.toLowerCase() === dashboardName.trim().toLowerCase()) {
      base = `${base} (sheet)`;
    }
    let candidate = base;
    let n = 2;
    while (usedLower.has(candidate.toLowerCase())) {
      candidate = `${base} ${n++}`;
    }
    usedLower.add(candidate.toLowerCase());
    map.set(ws.name, candidate);
  }
  return map;
}

/**
 * A worksheet has a "visual representation" only if it puts at least one field on a
 * shelf (dimension, measure, or KPI measure). Tableau rejects the whole workbook if a
 * dashboard references a sheet that is blank or absent ("...has no visual representation
 * in the workbook"), so we render (and reference) only worksheets that pass this test.
 */
function worksheetHasVisual(ws: WorksheetSpec): boolean {
  return ws.dimensions.length > 0 || ws.measures.length > 0 || Boolean(ws.kpiMeasure);
}

/**
 * Choose which worksheets go on the dashboard. Prefer the plan's layout items that
 * reference a rendered worksheet; if none do, auto-place all rendered worksheets in a
 * simple grid so the dashboard is never empty or references a missing/blank sheet.
 */
function computeDashboardItems(
  board: DashboardSpec,
  renderedNames: Set<string>,
  kpiNames: Set<string>,
): PlacedItem[] {
  const columns = Math.max(1, board.columns);
  const isKpi = (it: PlacedItem) => kpiNames.has(it.worksheet);

  const fromPlan = board.items
    .filter((it) => renderedNames.has(it.worksheet))
    .map((it) => ({ worksheet: it.worksheet, row: it.row, col: it.col, rowSpan: it.rowSpan, colSpan: it.colSpan }));
  const items =
    fromPlan.length > 0
      ? fromPlan
      : [...renderedNames].map((name, i) => ({
          worksheet: name,
          row: Math.floor(i / columns),
          col: i % columns,
          rowSpan: 1,
          colSpan: 1,
        }));
  return normalizeKpiRows(items, isKpi);
}

/**
 * Enforce a clean scorecard strip: ALL KPI cards are consolidated onto a SINGLE row at the
 * top (re-packed left-to-right), then the non-KPI charts follow below, preserving their
 * original row groupings but densely renumbered and re-packed per row so there are no
 * column gaps / empty cells. This guarantees one KPI row (never split across the board)
 * regardless of how the planner distributed the cards.
 */
function normalizeKpiRows(items: PlacedItem[], isKpi: (it: PlacedItem) => boolean): PlacedItem[] {
  const kpis = items.filter(isKpi);
  const others = items.filter((it) => !isKpi(it));
  const out: PlacedItem[] = [];
  let newRow = 0;

  // Every KPI card shares ONE row at the top, tiled from col 0 (keeps `allKpi` true so the
  // row stays pinned as a fixed-height strip in renderDashboard).
  if (kpis.length > 0) {
    [...kpis]
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .forEach((it, i) => out.push({ ...it, row: newRow, col: i, rowSpan: 1 }));
    newRow += 1;
  }

  // Charts follow, one dense row per original chart row, each re-packed from col 0.
  const chartRowIdxs = [...new Set(others.map((it) => it.row))].sort((a, b) => a - b);
  for (const ri of chartRowIdxs) {
    const rowItems = others.filter((it) => it.row === ri).sort((a, b) => a.col - b.col);
    rowItems.forEach((it, i) => out.push({ ...it, row: newRow, col: i }));
    newRow += 1;
  }
  return out;
}

/** A quick-filter control placed on the dashboard's right-hand panel. */
interface FilterControl {
  ref: string;
  sourceWorksheet: string;
  mode: string;
  values: string;
}
/** A parameter control placed on the dashboard's right-hand panel. */
interface ParamControl {
  ref: string;
  mode: string;
}
/** A color/size/shape legend placed on the dashboard's right-hand panel. */
interface LegendControl {
  worksheet: string;
  ref: string;
  encoding: 'color' | 'size' | 'shape';
  paneId: number;
}
/** Everything the dashboard needs to render its interactive control panel. */
interface DashboardControls {
  filters: FilterControl[];
  params: ParamControl[];
  legends: LegendControl[];
  /** Deduped `<column>` + `<column-instance>` decls for the dashboard deps block. */
  deps: { columnDecl: string; columnInstanceDecl: string }[];
  dsName: string;
  dsCaption: string;
  panelTitle: string;
}

/** A rectangle in Tableau's 0–100000 dashboard coordinate space. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Split a rect vertically (top→bottom) by weights; last row absorbs the remainder. */
function partitionV(rect: Rect, weights: number[]): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Rect[] = [];
  let y = rect.y;
  let used = 0;
  weights.forEach((wgt, i) => {
    const h = i === weights.length - 1 ? rect.h - used : Math.round((rect.h * wgt) / total);
    out.push({ x: rect.x, y, w: rect.w, h });
    y += h;
    used += h;
  });
  return out;
}

/** Split a rect horizontally (left→right) by weights; last cell absorbs the remainder. */
function partitionH(rect: Rect, weights: number[]): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Rect[] = [];
  let x = rect.x;
  let used = 0;
  weights.forEach((wgt, i) => {
    const w = i === weights.length - 1 ? rect.w - used : Math.round((rect.w * wgt) / total);
    out.push({ x, y: rect.y, w, h: rect.h });
    x += w;
    used += w;
  });
  return out;
}

/** `x/y/w/h` attribute string for a zone. */
function dims(r: Rect): string {
  return `h='${r.h}' w='${r.w}' x='${r.x}' y='${r.y}'`;
}

/**
 * Build the dashboard `<size>` element for the chosen sizing mode:
 *  - automatic → fits the window (no bounds).
 *  - fixed → exact width x height (min == max).
 *  - range → scales between (minWidth x minHeight) and (maxWidth x maxHeight).
 */
function buildDashboardSizeXml(layout: DashboardSpec): string {
  const w = layout.width;
  const h = layout.height;
  if (layout.size === 'automatic') return `      <size sizing-mode='automatic' />`;
  if (layout.size === 'range') {
    const minW = layout.minWidth ?? Math.round(w * 0.75);
    const minH = layout.minHeight ?? Math.round(h * 0.75);
    const maxW = Math.max(layout.maxWidth ?? w, minW);
    const maxH = Math.max(layout.maxHeight ?? h, minH);
    return `      <size maxheight='${maxH}' maxwidth='${maxW}' minheight='${minH}' minwidth='${minW}' sizing-mode='range' />`;
  }
  return `      <size maxheight='${h}' maxwidth='${w}' minheight='${h}' minwidth='${w}' sizing-mode='fixed' />`;
}

/** A `<zone-style>` block (border none + inner margin, optional background color). */
function zoneStyle(indent: string, margin: number, bg?: string): string {
  return [
    `${indent}<zone-style>`,
    `${indent}  <format attr='border-color' value='#000000' />`,
    `${indent}  <format attr='border-style' value='none' />`,
    `${indent}  <format attr='border-width' value='0' />`,
    `${indent}  <format attr='margin' value='${margin}' />`,
    ...(bg ? [`${indent}  <format attr='background-color' value='${escapeXml(bg)}' />`] : []),
    `${indent}</zone-style>`,
  ].join('\n');
}

/**
 * Render the dashboard using Tableau's real "sheet-in-container" structure (verified
 * against sample workbooks): a `layout-basic` root → a vertical `layout-flow` holding a
 * pinned title band and a horizontal content flow → a left vertical flow of ROW
 * containers (each row a horizontal flow whose CELLS are flow containers that each wrap
 * one worksheet with a white background) → an optional right, pinned Filters panel with
 * interactive filter/parameter controls. Nesting worksheets inside flow containers (not
 * flat absolute zones) is what makes the board resize cleanly and look author-made.
 */
function renderDashboard(
  board: DashboardSpec,
  kpiNames: Set<string>,
  nameMap: Map<string, string>,
  items: PlacedItem[],
  controls: DashboardControls,
): string {
  const sizeXml = buildDashboardSizeXml(board);

  const controlCount = controls.filters.length + controls.params.length + controls.legends.length;
  const hasPanel = controlCount > 0;
  const containerBg = board.containerBackground ?? '#ffffff';
  const dashboardBg = board.backgroundColor ?? '#e6e6e6';
  const innerMargin = 4;
  const title = (board.title ?? board.name).trim();
  // Title band font (customizable via the board's titleFormat).
  const tf = board.titleFormat;
  const titleBold = tf?.bold ?? true;
  const titleFontName = tf?.fontName ?? 'Tableau Bold';
  const titleFontSize = tf?.fontSize ?? 16;
  const titleFontColor = tf?.fontColor ?? '#1b1b1b';

  // Monotonic zone-id allocator (root is id 1).
  let idCounter = 1;
  const nid = () => ++idCounter;

  // Which worksheets are KPI cards? (Hide their sheet title + pin their row height.)
  const isKpiItem = (it: PlacedItem) => kpiNames.has(it.worksheet);

  // ---- Geometry (0–100000) --------------------------------------------------
  const root: Rect = { x: 0, y: 0, w: 100000, h: 100000 };
  const [titleRect, contentRect] = title
    ? (partitionV(root, [6, 94]) as [Rect, Rect])
    : ([null, root] as [Rect | null, Rect]);
  const [leftRect, panelRect] = hasPanel
    ? (partitionH(contentRect, [82, 18]) as [Rect, Rect])
    : ([contentRect, contentRect] as [Rect, Rect]);

  // Group placed items into rows (sorted), cells sorted by column.
  const rowIdxs = [...new Set(items.map((it) => it.row))].sort((a, b) => a - b);
  const rowGroups = rowIdxs.map((ri) =>
    items.filter((it) => it.row === ri).sort((a, b) => a.col - b.col),
  );
  const rowWeights = rowGroups.map((g) => Math.max(1, ...g.map((it) => it.rowSpan)));
  const rowRects = partitionV(leftRect, rowWeights);

  // ---- Chart rows (sheet-in-container) --------------------------------------
  const rowXml = rowGroups
    .map((group, ri) => {
      const rowRect = rowRects[ri]!;
      const cellRects = partitionH(rowRect, group.map((it) => Math.max(1, it.colSpan)));
      const allKpi = group.length > 0 && group.every(isKpiItem);
      const cells = group
        .map((item, ci) => {
          const cellRect = cellRects[ci]!;
          const containerId = nid();
          const wsId = nid();
          const wsName = nameMap.get(item.worksheet) ?? item.worksheet;
          const showTitle = isKpiItem(item) ? " show-title='false'" : '';
          return [
            `            <zone ${dims(cellRect)} id='${containerId}' param='horz' type-v2='layout-flow'>`,
            `              <zone ${dims(cellRect)} id='${wsId}' name='${escapeXml(wsName)}'${showTitle}>`,
            zoneStyle('                ', innerMargin),
            `              </zone>`,
            zoneStyle('              ', innerMargin, containerBg),
            `            </zone>`,
          ].join('\n');
        })
        .join('\n');
      const rowId = nid();
      // Pin KPI rows to a fixed height so they read as a scorecard strip.
      const rowFixed = allKpi ? `fixed-size='130' ` : '';
      const rowIsFixed = allKpi ? ` is-fixed='true' layout-strategy-id='distribute-evenly'` : '';
      return [
        `          <zone ${rowFixed}${dims(rowRect)} id='${rowId}'${rowIsFixed} param='horz' type-v2='layout-flow'>`,
        cells,
        `          </zone>`,
      ].join('\n');
    })
    .join('\n');

  const leftId = nid();
  const leftXml = [
    `        <zone ${dims(leftRect)} id='${leftId}' param='vert' type-v2='layout-flow'>`,
    rowXml,
    `        </zone>`,
  ].join('\n');

  // ---- Right Filters panel (interactive controls) ---------------------------
  let panelXml = '';
  if (hasPanel) {
    // Heading + one row per control. No trailing empty/spacer zone (avoids a blank
    // container in the dashboard).
    const panelParts = partitionV(panelRect, [1, ...Array(controlCount).fill(1)]);
    const headingRect = panelParts[0]!;
    const controlRects = panelParts.slice(1, 1 + controlCount);

    const headingId = nid();
    const heading = [
      `          <zone fixed-size='42' forceUpdate='true' ${dims(headingRect)} id='${headingId}' is-fixed='true' type-v2='text'>`,
      `            <formatted-text>`,
      `              <run bold='true' fontalignment='1' fontcolor='#1b1b1b' fontname='Tableau Semibold' fontsize='12'>${escapeXml(controls.panelTitle)}</run>`,
      `            </formatted-text>`,
      zoneStyle('            ', innerMargin),
      `          </zone>`,
    ].join('\n');

    let ci = 0;
    const filterZones = controls.filters.map((fc) => {
      const r = controlRects[ci++]!;
      return [
        `          <zone ${dims(r)} id='${nid()}' mode='${fc.mode}' name='${escapeXml(fc.sourceWorksheet)}' param='${fc.ref}' show-apply='true' type-v2='filter' values='${fc.values}'>`,
        zoneStyle('            ', innerMargin),
        `          </zone>`,
      ].join('\n');
    });
    const paramZones = controls.params.map((pc) => {
      const r = controlRects[ci++]!;
      return [
        `          <zone ${dims(r)} id='${nid()}' mode='${pc.mode}' param='${pc.ref}' type-v2='paramctrl'>`,
        zoneStyle('            ', innerMargin),
        `          </zone>`,
      ].join('\n');
    });
    // Legends (color/size/shape) live in the same right-hand panel container, when present.
    const legendZones = controls.legends.map((lg) => {
      const r = controlRects[ci++]!;
      return [
        `          <zone ${dims(r)} id='${nid()}' name='${escapeXml(lg.worksheet)}' pane-specification-id='${lg.paneId}' param='${lg.ref}' type-v2='${lg.encoding}'>`,
        zoneStyle('            ', innerMargin),
        `          </zone>`,
      ].join('\n');
    });

    const panelId = nid();
    panelXml = [
      `        <zone fixed-size='200' ${dims(panelRect)} id='${panelId}' is-fixed='true' param='vert' type-v2='layout-flow'>`,
      heading,
      ...filterZones,
      ...paramZones,
      ...legendZones,
      zoneStyle('          ', innerMargin, containerBg),
      `        </zone>`,
    ].join('\n');
  }

  const contentId = nid();
  const contentXml = [
    `      <zone ${dims(contentRect)} id='${contentId}' param='horz' type-v2='layout-flow'>`,
    leftXml,
    ...(panelXml ? [panelXml] : []),
    `      </zone>`,
  ].join('\n');

  // ---- Title band -----------------------------------------------------------
  let titleBand = '';
  if (title && titleRect) {
    const bandId = nid();
    const textId = nid();
    titleBand = [
      `      <zone fixed-size='50' ${dims(titleRect)} id='${bandId}' is-fixed='true' layout-strategy-id='distribute-evenly' param='vert' type-v2='layout-flow'>`,
      `        <zone ${dims(titleRect)} id='${textId}' type-v2='text'>`,
      `          <formatted-text>`,
      `            <run bold='${titleBold}' fontalignment='1' fontcolor='${titleFontColor}' fontname='${escapeXml(titleFontName)}' fontsize='${titleFontSize}'>${escapeXml(title)}</run>`,
      `          </formatted-text>`,
      zoneStyle('          ', innerMargin),
      `        </zone>`,
      `      </zone>`,
    ].join('\n');
  }

  const outerId = nid();
  const outer = [
    `    <zone ${dims(root)} id='${outerId}' param='vert' type-v2='layout-flow'>`,
    ...(titleBand ? [titleBand] : []),
    contentXml,
    `    </zone>`,
  ].join('\n');

  // Dashboard datasource wiring (needed for quick-filter controls to bind).
  const depBlock =
    controls.deps.length > 0
      ? [
          `      <datasources>`,
          `        <datasource caption='${escapeXml(controls.dsCaption)}' name='${controls.dsName}' />`,
          `      </datasources>`,
          `      <datasource-dependencies datasource='${controls.dsName}'>`,
          ...controls.deps.map((d) => `        ${d.columnDecl}`),
          ...controls.deps.map((d) => `        ${d.columnInstanceDecl}`),
          `      </datasource-dependencies>`,
        ].join('\n')
      : undefined;

  return [
    `    <dashboard name='${escapeXml(board.name)}'>`,
    `      <style>`,
    `        <style-rule element='table'>`,
    `          <format attr='background-color' value='${dashboardBg}' />`,
    `        </style-rule>`,
    `      </style>`,
    sizeXml,
    ...(depBlock ? [depBlock] : []),
    `      <zones>`,
    `        <zone h='100000' id='1' type-v2='layout-basic' w='100000' x='0' y='0'>`,
    outer,
    zoneStyle('          ', 8),
    `        </zone>`,
    `      </zones>`,
    `    </dashboard>`,
  ].join('\n');
}

/** Options controlling how the workbook binds to the published datasource. */
/**
 * Build the workbook-level `<actions>` block for the dashboard. A FILTER action makes
 * the dashboard interactive ("use as filter"): selecting/hovering a mark on a source
 * sheet filters the OTHER sheets on the same dashboard. KPI/scorecard sheets are
 * excluded as SOURCES so clicking a big number doesn't filter everything. Ported from
 * the sample workbook's filter action (`command='tsc:tsl-filter'`).
 */
function buildDashboardActionBlocks(
  dashName: string,
  placedFinalNames: string[],
  kpiFinalNames: Set<string>,
  actions: DashboardActionSpec[],
): string[] {
  // A filter action is only meaningful when at least two sheets are on the dashboard.
  if (actions.length === 0 || placedFinalNames.length < 2) return [];
  const blocks = actions
    .map((action, index) => {
      const explicit = new Set(action.excludeSheets ?? []);
      const excluded = placedFinalNames.filter(
        (w) => explicit.has(w) || kpiFinalNames.has(w) || /kpi/i.test(w),
      );
      // Need at least one non-excluded sheet to act as the filter source.
      if (placedFinalNames.length - excluded.length < 1) return '';
      const caption = action.caption ?? `Filter on ${dashName}`;
      const hex = randomUUID().replace(/-/g, '').toUpperCase();
      const name = `Action${index}_${hex}`;
      const activation =
        action.runOn === 'hover'
          ? `<activation auto-clear='true' type='on-hover' />`
          : action.runOn === 'menu'
            ? `<activation type='on-menu' />`
            : `<activation auto-clear='true' type='on-select' />`;
      const excludeXml = excluded
        .map((w) => `        <exclude-sheet name='${escapeXml(w)}' />`)
        .join('\n');
      return [
        `    <action caption='${escapeXml(caption)}' name='[${name}]'>`,
        `      ${activation}`,
        `      <source dashboard='${escapeXml(dashName)}' type='sheet'>`,
        ...(excludeXml ? [excludeXml] : []),
        `      </source>`,
        `      <command command='tsc:tsl-filter'>`,
        `        <param name='special-fields' value='all' />`,
        `        <param name='target' value='${escapeXml(dashName)}' />`,
        `      </command>`,
        `    </action>`,
      ].join('\n');
    })
    .filter((b): b is string => b !== '');
  return blocks;
}

export interface GenerateTwbOptions {
  /**
   * The pod's data-server host (the hostname of the Tableau Cloud server URL, e.g.
   * `prod-in-a.online.tableau.com`). Emitted as the `server` attribute of the sqlproxy
   * connection so the workbook can reach the published datasource through the data server.
   * Without it the workbook cannot load a published datasource.
   */
  serverHost?: string;
}

/**
 * Normalize a field name for collision comparison: trim, collapse internal
 * whitespace, and lower-case. Tableau treats field names case-insensitively, and
 * datasource metadata occasionally differs from a plan by incidental whitespace.
 */
export function normalizeFieldKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Return a copy of the plan with any calculated fields whose name matches one of
 * `names` removed (case/whitespace-insensitive). Worksheet references to the field
 * are left intact so they resolve to the datasource's existing field instead. Used
 * to recover from Tableau's "field is already defined by data source" publish error.
 */
export function removeCalculatedFields(plan: DashboardPlan, names: Iterable<string>): DashboardPlan {
  const drop = new Set([...names].map(normalizeFieldKey));
  if (drop.size === 0) return plan;
  return {
    ...plan,
    calculatedFields: plan.calculatedFields.filter((c) => !drop.has(normalizeFieldKey(c.name))),
    worksheets: plan.worksheets.map((w) => ({
      ...w,
      calculations: w.calculations.filter((c) => !drop.has(normalizeFieldKey(c.name))),
    })),
  };
}

/**
 * Extract the calculated-field name(s) Tableau reports as already defined by the
 * datasource from a publish error message, e.g.
 *   Ignoring calculated field '[Profit Margin %]', field is already defined by data source.
 */
export function parseAlreadyDefinedCalcFields(message: string): string[] {
  const out: string[] = [];
  const re = /Ignoring calculated field '\[([^\]]+)\]',\s*field is already defined by data source/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Generate the full .twb XML string for a plan + live datasource metadata. */
export function generateTwb(
  planInput: DashboardPlan,
  metadata: DatasourceMetadata,
  opts: GenerateTwbOptions = {},
): string {
  // Internalize calculated fields FIRST: rewrite every calc reference to a unique internal
  // name (`Calculation_N`, caption = display name) and collect the calc definitions. This
  // guarantees a calc never collides with a same-named datasource field (which would blank
  // the chart) and always carries its formula. Datasource-defined calcs are internalized too.
  const { plan, calcs } = internalizeCalcs(planInput, metadata);
  // Full calc `<column>` decls (with formula) for worksheet datasource-dependencies, keyed by
  // normalized internal name — a worksheet redeclares each calc it uses (matches real Tableau).
  const calcColumnByName = new Map<string, string>(
    calcs.map((c) => [normalizeFieldKey(c.internalName), buildCalcColumnXml(c, '            ')]),
  );

  // Render ONLY worksheets that produce a visual — Tableau rejects the workbook if a
  // dashboard references a blank/absent sheet.
  const rendered = plan.worksheets.filter(worksheetHasVisual);
  const nameMap = buildWorksheetNameMap(rendered, plan.dashboardName);
  const renderedNames = new Set(rendered.map((ws) => ws.name));
  const finalName = (originalName: string) => nameMap.get(originalName) ?? originalName;

  // ---- Boards (one or many dashboards) --------------------------------------
  // Worksheets are a SHARED pool; each board arranges a subset. When the planner
  // produced explicit `dashboards[]`, emit exactly those; otherwise synthesize a single
  // board from `layout` + `dashboardName` (backward-compatible with single-dashboard plans).
  const kpiNames = new Set(plan.worksheets.filter((w) => w.chartType === 'kpi').map((w) => w.name));
  const boards: DashboardSpec[] =
    plan.dashboards.length > 0 ? plan.dashboards : [{ ...plan.layout, name: plan.dashboardName }];

  // Calculated fields whose formula is ALREADY aggregated (top-level SUM/AVG/…) must be placed
  // as `AGG(field)` (derivation User), NOT re-wrapped in SUM(...) — otherwise Tableau errors
  // ("cannot mix aggregate and non-aggregate") or renders a blank sheet. Detected during
  // internalization; keyed by the calc's unique internal name.
  const aggregatedCalcNames = new Set<string>(
    calcs.filter((c) => c.aggregated).map((c) => normalizeFieldKey(c.internalName)),
  );

  // ---- Interactive filters + parameters --------------------------------------
  // Top/Bottom-N ALWAYS gets a "Top N" parameter that drives its count, so the user can
  // change N live. Reuse the planner's parameter (by caption) when present, else create
  // one. Collect these before resolving parameters so they land in the Parameters ds.
  const topNFilters: FilterSpec[] = [
    ...plan.filters.filter((f) => f.operator === 'top_n' && f.topN),
    ...rendered.flatMap((ws) => ws.filters.filter((f) => f.operator === 'top_n' && f.topN)),
  ];
  const captionForTopN = new Map<FilterSpec, string>();
  const extraParamSpecs: ParameterSpec[] = [];
  const plannerParamNames = new Set(plan.parameters.map((p) => p.name.trim().toLowerCase()));
  // Integer planner params are candidates to DRIVE a Top-N N. Reuse one (rather than
  // minting a duplicate) so the parameter the user SEES on the dashboard is the exact
  // one the filter's count references — otherwise the planner's control is a dead slider.
  const integerPlannerParams = plan.parameters.filter((p) => p.dataType === 'integer');
  const soleIntegerParam = integerPlannerParams.length === 1 ? integerPlannerParams[0] : undefined;
  for (const f of topNFilters) {
    const explicit = f.topN?.nParameter?.trim();
    let caption: string;
    if (explicit) {
      // Honor an explicit binding (whether or not a matching planner param exists yet).
      caption = explicit;
    } else {
      // No explicit name: bind to a compatible planner integer parameter (a "Top N"-ish
      // one, else the sole integer param) so the shown control drives this filter.
      const reuse =
        integerPlannerParams.find((p) => /top\s*n|\btop\b/i.test(p.name)) ?? soleIntegerParam;
      caption = reuse ? reuse.name.trim() : `Top N ${f.field}`;
    }
    captionForTopN.set(f, caption);
    const key = caption.toLowerCase();
    const alreadyExists =
      plannerParamNames.has(key) || extraParamSpecs.some((p) => p.name.trim().toLowerCase() === key);
    if (!alreadyExists) {
      const n = f.topN?.n ?? 10;
      extraParamSpecs.push({
        name: caption,
        dataType: 'integer',
        currentValue: String(n),
        range: { min: 1, max: Math.max(20, n * 2), step: 1 },
      });
    }
  }

  const resolvedParams = resolveParameters([...plan.parameters, ...extraParamSpecs]);
  const paramByCaption = new Map(resolvedParams.map((p) => [p.spec.name.trim().toLowerCase(), p]));
  const topNParamFor = (spec: FilterSpec): ResolvedParameter | undefined => {
    const cap = captionForTopN.get(spec);
    return cap ? paramByCaption.get(cap.toLowerCase()) : undefined;
  };

  // Top-N rule: a Top-N ranking only respects the other slicer filters when those are
  // CONTEXT filters (Tableau evaluates context first, then ranks within that subset).
  // So when ANY worksheet/dashboard filter is a Top-N, promote all the OTHER filters to
  // context; otherwise emit no context filters at all. (The Top-N filter itself is never
  // a context filter — it's the thing that depends on the context.)
  const hasTopN = topNFilters.length > 0;
  const useContext = (spec: { operator: string }) => hasTopN && spec.operator !== 'top_n';

  // Per-worksheet applied-filter accumulator (keyed by ORIGINAL worksheet name).
  const wsFilters = new Map<string, AppliedFilter[]>();
  const addFilter = (wsOriginal: string, af: AppliedFilter) => {
    const list = wsFilters.get(wsOriginal) ?? [];
    list.push(af);
    wsFilters.set(wsOriginal, list);
  };

  // Which worksheets (ORIGINAL names) actually use each parameter (by control ref). Used to
  // place an auto-created Top-N parameter control only on the board(s) hosting its chart.
  const paramUsersByRef = new Map<string, Set<string>>();
  const noteParamUser = (ref: string, wsOriginal: string): void => {
    const set = paramUsersByRef.get(ref) ?? new Set<string>();
    set.add(wsOriginal);
    paramUsersByRef.set(ref, set);
  };

  // Dashboard-level filters are applied to their target worksheets, and (when marked as a
  // control) become panel controls on whichever board(s) actually host a target sheet.
  interface Controllable {
    ref: string;
    mode: string;
    targets: Set<string>;
    /** A global (apply-to-all) filter must appear on EVERY board, not just target boards. */
    global: boolean;
    instanceName: string;
    columnDecl: string;
    columnInstanceDecl: string;
  }
  const controllable: Controllable[] = [];
  const dimsOf = new Map(rendered.map((w) => [w.name, new Set(w.dimensions)]));
  let filterGroupSeq = 0;
  for (const spec of plan.filters) {
    const resolved = resolveFilter(spec, metadata, DS_NAME);
    if (!resolved || !resolved.hasFilterXml) continue;

    // Which rendered worksheets does this filter target?
    const selected = spec.scope === 'selected_worksheets' && spec.worksheets && spec.worksheets.length > 0;
    let targets: string[] = selected
      ? spec.worksheets!.filter((n) => renderedNames.has(n))
      : [...renderedNames];
    // A Top-N ranking only makes sense on worksheets that actually plot the ranked
    // dimension; applying it to KPI cards or unrelated charts does nothing (and can
    // make the parameter appear to "not work"). Restrict to sheets using that field.
    if (resolved.isTopN) {
      targets = targets.filter((n) => dimsOf.get(n)?.has(spec.field));
    }
    if (targets.length === 0) continue;

    // Apply-to-all across sheets is a shared filter-group (independent of context).
    const multi = targets.length > 1;
    const filterGroup = multi ? ++filterGroupSeq : undefined;
    const context = useContext(spec);
    const param = resolved.isTopN ? topNParamFor(spec) : undefined;
    const topNCount = param?.ref;
    for (const t of targets) {
      addFilter(t, { resolved, context, filterGroup, topNCount, param });
      if (param) noteParamUser(param.ref, t);
    }

    // A Top-N isn't a checkbox control; its N is driven by its parameter control instead.
    if (spec.showAsControl && !resolved.isTopN) {
      controllable.push({
        ref: resolved.ref,
        mode: resolved.isMeasure ? 'slider' : 'checkdropdown',
        targets: new Set(targets),
        global: !selected, // apply-to-all filters belong on every dashboard
        instanceName: resolved.instanceName,
        columnDecl: resolved.columnDecl,
        columnInstanceDecl: resolved.columnInstanceDecl,
      });
    }
  }

  // Worksheet-local filters (applied only to that sheet, not shown as a control).
  for (const ws of rendered) {
    for (const spec of ws.filters) {
      const resolved = resolveFilter(spec, metadata, DS_NAME);
      if (!resolved || !resolved.hasFilterXml) continue;
      const param = resolved.isTopN ? topNParamFor(spec) : undefined;
      addFilter(ws.name, { resolved, context: useContext(spec), topNCount: param?.ref, param });
      if (param) noteParamUser(param.ref, ws.name);
    }
  }

  // Render every worksheet ONCE (legends are not auto-surfaced onto the dashboard panel).
  const worksheets = rendered
    .map(
      (ws) =>
        renderWorksheet({
          ws,
          finalName: finalName(ws.name),
          dsName: DS_NAME,
          dsCaption: plan.datasource.datasourceName,
          metadata,
          filters: wsFilters.get(ws.name) ?? [],
          aggregatedCalcNames,
          calcColumnByName,
        }).xml,
    )
    .join('\n');

  // Auto-created Top-N parameters are tied to a specific chart; user-defined parameters are
  // global. Top-N param controls only appear on the board(s) hosting their chart; user
  // params appear on every board.
  const topNParamCaptions = new Set([...captionForTopN.values()].map((c) => c.trim().toLowerCase()));
  const isTopNParam = (p: ResolvedParameter): boolean => topNParamCaptions.has(p.spec.name.trim().toLowerCase());

  // Windows: one <window class='worksheet'> per rendered worksheet FIRST, then one
  // dashboard window per board. Unique names ensure every reference resolves correctly.
  const worksheetWindows = rendered
    .map((ws) => `    <window class='worksheet' name='${escapeXml(finalName(ws.name))}' />`)
    .join('\n');

  // ---- Per-board assembly ----------------------------------------------------
  const boardXmls: string[] = [];
  const boardWindows: string[] = [];
  const actionBlocks: string[] = [];

  for (const board of boards) {
    const items = computeDashboardItems(board, renderedNames, kpiNames);
    const placedList = items.map((it) => it.worksheet);

    // Filter controls that belong on THIS board. A GLOBAL (apply-to-all) filter appears on
    // every board (anchored to any sheet here); a selected-scope filter only where a target
    // sheet is actually placed.
    const boardFilters: FilterControl[] = [];
    const boardDeps = new Map<string, { columnDecl: string; columnInstanceDecl: string }>();
    // Prefer a NON-KPI chart as the filter card's anchor worksheet — Tableau renders a
    // quick-filter card reliably against a real chart, but poorly against a KPI card.
    const nonKpiPlaced = placedList.filter((n) => !kpiNames.has(n));
    for (const cf of controllable) {
      const targetsHere = placedList.filter((n) => cf.targets.has(n));
      const anchor =
        targetsHere.find((n) => !kpiNames.has(n)) ??
        targetsHere[0] ??
        (cf.global ? (nonKpiPlaced[0] ?? placedList[0]) : undefined);
      if (!anchor) continue;
      boardFilters.push({ ref: cf.ref, sourceWorksheet: finalName(anchor), mode: cf.mode, values: 'relevant' });
      boardDeps.set(cf.instanceName, { columnDecl: cf.columnDecl, columnInstanceDecl: cf.columnInstanceDecl });
    }

    // Param controls for THIS board: user params always; Top-N params only where the chart
    // they drive is actually placed (so there's no dead control on an unrelated board).
    const boardParams: ParamControl[] = resolvedParams
      .filter((p) => {
        // Integer/float ("Top N"-style) params are placed ONLY when a filter on a sheet on
        // THIS board actually references them; otherwise the slider is a dead control that
        // does nothing when dragged. String/boolean/date params always surface.
        const driverLike = isTopNParam(p) || p.spec.dataType === 'integer' || p.spec.dataType === 'float';
        if (!driverLike) return true;
        const users = paramUsersByRef.get(p.ref);
        return users ? placedList.some((n) => users.has(n)) : false;
      })
      .map((p) => ({ ref: p.ref, mode: p.controlMode }));

    // Legends are NOT added automatically — a color/size legend only appears when the user
    // explicitly asks for one (keeps the Filters panel clean by default).
    const boardLegends: LegendControl[] = [];

    const controls: DashboardControls = {
      filters: boardFilters,
      params: boardParams,
      legends: boardLegends,
      deps: [...boardDeps.values()],
      dsName: DS_NAME,
      dsCaption: plan.datasource.datasourceName,
      panelTitle: 'Filters',
    };

    boardXmls.push(renderDashboard(board, kpiNames, nameMap, items, controls));

    // Dashboard window with a viewpoint per placed sheet.
    const viewpoints = placedList
      .map((n) => `      <viewpoint name='${escapeXml(finalName(n))}'>\n        <zoom type='entire-view' />\n      </viewpoint>`)
      .join('\n');
    boardWindows.push(
      [
        `    <window class='dashboard' name='${escapeXml(board.name)}'>`,
        `      <viewpoints>`,
        viewpoints,
        `      </viewpoints>`,
        `      <active id='-1' />`,
        `    </window>`,
      ].join('\n'),
    );

    // Actions (interactivity) for this board. A board-level decision overrides the
    // plan-level one; with no decision at all we default to a single on-select filter.
    const source = board.actions ?? plan.actions;
    const filterActions = source.filter((a) => a.type === 'filter');
    const boardActions: DashboardActionSpec[] =
      source.length > 0 ? filterActions : [{ type: 'filter', runOn: 'select', excludeSheets: [] }];
    const placedFinalNames = placedList.map((n) => finalName(n));
    const kpiFinalNames = new Set(placedList.filter((n) => kpiNames.has(n)).map((n) => finalName(n)));
    actionBlocks.push(...buildDashboardActionBlocks(board.name, placedFinalNames, kpiFinalNames, boardActions));
  }

  const actionsBlock =
    actionBlocks.length > 0 ? [`  <actions>`, ...actionBlocks, `  </actions>`].join('\n') : '';

  // Assemble the <datasources> block: the sqlproxy data datasource + (optionally) the
  // inline Parameters pseudo-datasource that holds any parameter controls.
  const dataDatasources = renderDatasource(plan, metadata, calcs, opts.serverHost);
  const paramDs = renderParametersDatasource(resolvedParams);
  const datasourcesBlock = paramDs
    ? dataDatasources.replace('  <datasources>\n', `  <datasources>\n${paramDs}\n`)
    : dataDatasources;

  return [
    `<?xml version='1.0' encoding='utf-8' ?>`,
    `<!-- Generated by TableauPilot AI from an approved, Zod-validated DashboardPlan. -->`,
    `<workbook version='${WORKBOOK_VERSION}' xmlns:user='http://www.tableausoftware.com/xml/user'>`,
    datasourcesBlock,
    ...(actionsBlock ? [actionsBlock] : []),
    `  <worksheets>`,
    worksheets,
    `  </worksheets>`,
    `  <dashboards>`,
    ...boardXmls,
    `  </dashboards>`,
    `  <windows>`,
    worksheetWindows,
    ...boardWindows,
    `  </windows>`,
    `</workbook>`,
  ].join('\n');
}
