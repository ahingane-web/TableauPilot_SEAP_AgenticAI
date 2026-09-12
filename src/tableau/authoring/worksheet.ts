/**
 * Chart-type-aware worksheet renderer.
 *
 * Turns a validated {@link WorksheetSpec} into a `<worksheet>` element that renders a
 * REAL visual: it respects the chosen chart type (mark class + shelf placement +
 * encodings), emits proper column-instances (discrete/continuous, date truncation,
 * aggregation), value labels, number formatting, KPI cards, dual-axis panes and maps.
 *
 * Field references resolve against the locked datasource name (`dsName`, e.g.
 * `sqlproxy.tableaupilot`) so the worksheet binds to the published datasource.
 */
import { randomUUID } from 'node:crypto';
import type { WorksheetSpec, MeasureRef } from '../../schemas/worksheetSpec.js';
import type { DateDerivation } from '../../schemas/common.js';
import type { DatasourceField, DatasourceMetadata } from '../types.js';
import { escapeXml, twbDataType, measureDatatype } from './xml.js';
import { resolvePill, type ResolvedPill, type TwbDataType } from './pill.js';
import { getChartRecipe, type ChartRecipe } from './chartRegistry.js';
import { buildNumberFormat, looksLikeCurrency } from './numberFormat.js';
import type { ResolvedFilter } from './filters.js';
import { renderWorksheetParameterDeps, type ResolvedParameter } from './parameters.js';

/** A filter applied to a worksheet, with apply-to-all wiring. */
export interface AppliedFilter {
  resolved: ResolvedFilter;
  context?: boolean;
  filterGroup?: number;
  /** Count expression for a Top-N filter (e.g. `[Parameters].[Parameter k]`). */
  topNCount?: string;
  /** Parameter this filter references (so the worksheet declares the Parameters dep). */
  param?: ResolvedParameter;
}

/** A color/size/shape legend a worksheet exposes (surfaced on the dashboard panel). */
export interface WorksheetLegend {
  encoding: 'color' | 'size' | 'shape';
  /** The field reference driving the legend, e.g. `[ds].[none:Category:nk]`. */
  ref: string;
  paneId: number;
  /** Field decls so the dashboard can declare the legend's datasource dependency. */
  columnDecl: string;
  columnInstanceDecl: string;
  instanceName: string;
}

/** renderWorksheet result: the `<worksheet>` XML plus the legends it exposes. */
export interface RenderWorksheetResult {
  xml: string;
  legends: WorksheetLegend[];
}

/** Dimension names that Tableau can plot on a generated map. */
const GEO_RE = /\b(country|region|state|province|city|county|postal|zip|zipcode|latitude|longitude|cbsa|msa)\b/i;

/** Encoding shelf → XML element name. */
const ENCODING_ELEMENT: Record<string, string> = {
  color: 'color',
  size: 'size',
  label: 'text',
  detail: 'lod',
  shape: 'shape',
  angle: 'wedge-size',
  path: 'path',
};

interface Encoding {
  shelf: keyof typeof ENCODING_ELEMENT;
  ref: string;
}

interface Layout {
  rows: string;
  cols: string;
  encodings: Encoding[];
  markClass: string;
  /** Full `<panes>...</panes>` override (dual axis). */
  panesOverride?: string;
  /** Extra XML inside the single `<pane>` (KPI customized-label + style). */
  paneExtra?: string;
  /** Extra table-level `<style-rule>` fragments (number format, labels). */
  styleRules: string[];
  mapsources?: boolean;
}

/** Join multiple pills on one shelf: measures with `+`, dimensions with `/`. */
function buildShelf(refs: string[], kind: 'measure' | 'dim'): string {
  if (refs.length === 0) return '';
  if (refs.length === 1) return refs[0] ?? '';
  return `(${refs.join(kind === 'measure' ? ' + ' : ' / ')})`;
}

export interface RenderWorksheetOpts {
  ws: WorksheetSpec;
  finalName: string;
  dsName: string;
  dsCaption: string;
  metadata: DatasourceMetadata;
  /** Filters to apply to this worksheet (from the dashboard + the worksheet itself). */
  filters?: AppliedFilter[];
  /**
   * Normalized names (trim/collapse/lowercase) of calculated fields whose formula is
   * ALREADY aggregated. A measure referencing one is emitted as `AGG(field)` (User
   * derivation), never re-wrapped in SUM(...). See twbGenerator.aggregatedCalcNames.
   */
  aggregatedCalcNames?: Set<string>;
  /**
   * Full calc `<column>…<calculation/></column>` decls (indented for worksheet
   * datasource-dependencies), keyed by normalized internal calc name. A worksheet
   * redeclares each calc it uses WITH its formula (matches real Tableau); without this a
   * plain column stub would shadow the calc and blank the chart.
   */
  calcColumnByName?: Map<string, string>;
}

/** Normalize a field name for aggregated-calc matching (matches twbGenerator). */
function normalizeKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function renderWorksheet(opts: RenderWorksheetOpts): RenderWorksheetResult {
  const { ws, finalName, dsName, dsCaption, metadata } = opts;
  const applied = opts.filters ?? [];
  const recipe = getChartRecipe(ws.chartType);
  const isKpi = ws.chartType === 'kpi' || recipe.strategy === 'kpi';
  const byName = new Map(metadata.fields.map((f) => [f.name, f]));

  const measures: MeasureRef[] = ws.measures.length ? ws.measures : ws.kpiMeasure ? [ws.kpiMeasure] : [];
  const dims = ws.dimensions;

  // Declaration accumulators (deduped) for <datasource-dependencies>.
  const baseCols = new Map<string, string>();
  const instances = new Map<string, string>();
  const extraDecls = new Set<string>();
  const pillByRef = new Map<string, ResolvedPill>();
  const calcColumns = opts.calcColumnByName;
  const register = (pill: ResolvedPill): ResolvedPill => {
    if (!baseCols.has(pill.name)) {
      // A calculated field is redeclared WITH its formula (not a plain stub), so it resolves
      // and renders instead of being shadowed by an empty column.
      const calcDecl = calcColumns?.get(normalizeKey(pill.name));
      baseCols.set(pill.name, calcDecl ?? `            ${pill.columnDecl}`);
    }
    instances.set(pill.instanceName, `            ${pill.columnInstanceDecl}`);
    pillByRef.set(pill.ref(dsName), pill);
    return pill;
  };

  const aggSet = opts.aggregatedCalcNames;
  // A measure is aggregated if the planner flagged it OR its calc formula is detected
  // as already-aggregated (deterministic; independent of the LLM remembering the flag).
  const isAgg = (m: MeasureRef): boolean => m.aggregated === true || (aggSet?.has(normalizeKey(m.field)) ?? false);
  const dimPill = (name: string): ResolvedPill => register(makeDimPill(name, byName.get(name), recipe));
  const measPill = (m: MeasureRef): ResolvedPill => register(makeMeasurePill(m, byName.get(m.field), false, isAgg(m)));
  // Discrete (blue) measure pill — used for detail/crosstab rows.
  const measDiscPill = (m: MeasureRef): ResolvedPill => register(makeMeasurePill(m, byName.get(m.field), true, isAgg(m)));

  const layout = placeFields(recipe, ws, dims, measures, dimPill, measPill, measDiscPill, dsName, finalName);

  // User-selected COLOR-mark field (overrides the chart's default color encoding). A
  // dimension colors by category (discrete); a measure colors by value (continuous).
  // Skipped for KPI cards, which render a headline value (no color mark).
  const colorField = ws.formatting?.colorField;
  if (colorField && !isKpi) {
    for (let i = layout.encodings.length - 1; i >= 0; i--) {
      if (layout.encodings[i]!.shelf === 'color') layout.encodings.splice(i, 1);
    }
    const fld = byName.get(colorField);
    const ref = fld?.role === 'measure' ? measPill({ field: colorField, aggregation: 'sum' }).ref(dsName) : dimPill(colorField).ref(dsName);
    layout.encodings.push({ shelf: 'color', ref });
  }

  // Filters: declare each filtered field's column-instance and emit the <filter> +
  // <slices> XML. Filtered columns must appear in datasource-dependencies too.
  const filterXmlParts: string[] = [];
  const sliceLines: string[] = [];
  const shelfSortLines: string[] = [];
  const usedParams = new Map<string, ResolvedParameter>();
  for (const af of applied) {
    if (!af.resolved.hasFilterXml) continue;
    register(af.resolved.pill);
    // Top-N ranking measure: register the FULL pill so both its <column> and
    // <column-instance> are declared (a missing instance makes ranking no-op).
    if (af.resolved.rankMeasurePill) register(af.resolved.rankMeasurePill);
    for (const decl of af.resolved.extraColumnDecls) extraDecls.add(decl);
    if (af.param) usedParams.set(af.param.name, af.param);
    filterXmlParts.push(
      af.resolved.buildFilterXml({ context: af.context, filterGroup: af.filterGroup, topNCount: af.topNCount }),
    );
    if (af.resolved.sliceLine) sliceLines.push(af.resolved.sliceLine);
    // A Top-N chart sorts its ranked dimension by the ranking measure (matches the sample
    // workbook), so the bars actually read as a ranked "top/bottom N".
    if (af.resolved.isTopN && af.resolved.rankMeasurePill) {
      const dimRef = af.resolved.ref;
      const measRef = af.resolved.rankMeasurePill.ref(dsName);
      const dir = af.resolved.spec.topN?.direction === 'bottom' ? 'ASC' : 'DESC';
      const shelf = layout.cols.includes(dimRef) ? 'cols' : 'rows';
      shelfSortLines.push(
        `            <shelf-sort-v2 dimension-to-sort='${dimRef}' direction='${dir}' is-on-innermost-dimension='true' measure-to-sort-by='${measRef}' shelf='${shelf}' />`,
      );
    }
  }
  // On a Top-N sheet, <slices> lists ONLY the ranked dimension (mirrors the sample); the
  // apply-to-all context slicers are still applied via their <filter> elements.
  const hasTopNHere = applied.some((af) => af.resolved.isTopN && af.resolved.hasFilterXml);
  const effectiveSliceLines = hasTopNHere
    ? applied
        .filter((af) => af.resolved.isTopN && af.resolved.sliceLine)
        .map((af) => af.resolved.sliceLine as string)
    : sliceLines;
  const slicesBlock =
    effectiveSliceLines.length > 0
      ? ['          <slices>', ...effectiveSliceLines, '          </slices>'].join('\n')
      : undefined;
  const shelfSortsBlock =
    shelfSortLines.length > 0
      ? ['          <shelf-sorts>', ...shelfSortLines, '          </shelf-sorts>'].join('\n')
      : undefined;
  const paramDeps = renderWorksheetParameterDeps([...usedParams.values()]);

  // Encodings block.
  const encodingsXml =
    layout.encodings.length > 0
      ? [
          '            <encodings>',
          ...layout.encodings.map((e) => `              <${ENCODING_ELEMENT[e.shelf]} column='${e.ref}' />`),
          '            </encodings>',
        ].join('\n')
      : undefined;

  // Reference / average / constant lines (pane-level) + optional fill bands (table-level).
  const reflineLines: string[] = [];
  const reflineFillFormats: string[] = [];
  (ws.referenceLines ?? []).forEach((rl, i) => {
    const ref = measPill({ field: rl.field, aggregation: rl.aggregation }).ref(dsName);
    if (rl.formula === 'constant') {
      reflineLines.push(
        `            <reference-line axis-column='${ref}' enable-instant-analytics='true' id='refline${i}' label-type='${rl.labelType}' scope='${rl.scope}' value='${rl.value ?? 0}' z-order='1' />`,
      );
    } else {
      const formula = REFLINE_FORMULA[rl.formula] ?? 'average';
      reflineLines.push(
        `            <reference-line axis-column='${ref}' enable-instant-analytics='true' formula='${formula}' id='refline${i}' label-type='${rl.labelType}' scope='${rl.scope}' value-column='${ref}' z-order='1' />`,
      );
    }
    if (rl.fillAbove) reflineFillFormats.push(`            <format attr='fill-above' id='refline${i}' value='${escapeXml(rl.fillAbove)}' />`);
    if (rl.fillBelow) reflineFillFormats.push(`            <format attr='fill-below' id='refline${i}' value='${escapeXml(rl.fillBelow)}' />`);
  });
  const reflineXml = reflineLines.length > 0 ? reflineLines.join('\n') : undefined;
  const reflineFillRule =
    reflineFillFormats.length > 0
      ? [`          <style-rule element='refline'>`, ...reflineFillFormats, `          </style-rule>`].join('\n')
      : undefined;

  // Per-member color palette for the color-encoded dimension.
  let colorRule: string | undefined;
  if (ws.colorMap) {
    const colorEnc = layout.encodings.find(
      (e) => e.shelf === 'color' && pillByRef.get(e.ref)?.name === ws.colorMap!.field,
    );
    const pill = colorEnc ? pillByRef.get(colorEnc.ref) : undefined;
    if (pill) {
      const maps = ws.colorMap.colors
        .map((c) =>
          [
            `              <map to='${escapeXml(c.color)}'>`,
            `                <bucket>&quot;${escapeXml(c.value)}&quot;</bucket>`,
            `              </map>`,
          ].join('\n'),
        )
        .join('\n');
      colorRule = [
        `          <style-rule element='mark'>`,
        `            <encoding attr='color' field='[${pill.instanceName}]' type='palette'>`,
        maps,
        `            </encoding>`,
        `          </style-rule>`,
      ].join('\n');
    }
  }

  // Grand totals: a totals column (row) and/or a totals row (column).
  const rowsAttr = ws.grandTotals?.row ? " total='true'" : '';
  const colsAttr = ws.grandTotals?.column ? " total='true'" : '';

  // Table <style> block: measure number formats + value labels + color palette + refline fills.
  const tableStyleRules = [
    ...layout.styleRules,
    ...(colorRule ? [colorRule] : []),
    ...(reflineFillRule ? [reflineFillRule] : []),
  ];
  const styleBlock =
    tableStyleRules.length > 0
      ? ['        <style>', ...tableStyleRules, '        </style>'].join('\n')
      : '        <style />';

  // Extra (e.g. Top-N ranking measure) columns, minus any already declared on a shelf.
  const baseDeclSet = new Set(baseCols.values());
  const extraOnly = [...extraDecls].filter((d) => !baseDeclSet.has(d));
  const depLines = [...baseCols.values(), ...extraOnly, ...instances.values()].join('\n');

  // Worksheet title formatting: bold, size 12 by default (customizable via
  // formatting.titleFormat); hidden for KPI cards on the dashboard.
  const titleText = ws.formatting?.title ?? finalName;
  const tf = ws.formatting?.titleFormat;
  const titleBold = tf?.bold ?? true;
  const titleFontName = tf?.fontName ?? 'Tableau Bold';
  const titleFontSize = tf?.fontSize ?? 12;
  const titleColorAttr = tf?.fontColor ? ` fontcolor='${tf.fontColor}'` : '';
  const titleLayout = isKpi
    ? undefined
    : [
        `      <layout-options>`,
        `        <title>`,
        `          <formatted-text>`,
        `            <run bold='${titleBold}'${titleColorAttr} fontname='${escapeXml(titleFontName)}' fontsize='${titleFontSize}'>${escapeXml(titleText)}</run>`,
        `          </formatted-text>`,
        `        </title>`,
        `      </layout-options>`,
      ].join('\n');

  // Legends this worksheet exposes (color/size/shape encodings) for the dashboard panel.
  const legends: WorksheetLegend[] = layout.encodings
    .filter((e) => e.shelf === 'color' || e.shelf === 'size' || e.shelf === 'shape')
    .map((e) => {
      const pill = pillByRef.get(e.ref);
      return {
        encoding: e.shelf as WorksheetLegend['encoding'],
        ref: e.ref,
        paneId: 0,
        columnDecl: pill?.columnDecl ?? '',
        columnInstanceDecl: pill?.columnInstanceDecl ?? '',
        instanceName: pill?.instanceName ?? e.ref,
      };
    });

  const panes =
    layout.panesOverride ??
    [
      `        <panes>`,
      `          <pane selection-relaxation-option='selection-relaxation-allow'>`,
      `            <view>`,
      `              <breakdown value='auto' />`,
      `            </view>`,
      `            <mark class='${layout.markClass}' />`,
      ...(encodingsXml ? [encodingsXml] : []),
      ...(reflineXml ? [reflineXml] : []),
      ...(layout.paneExtra ? [layout.paneExtra] : []),
      `          </pane>`,
      `        </panes>`,
    ].join('\n');

  const xml = [
    `    <worksheet name='${escapeXml(finalName)}'>`,
    ...(titleLayout ? [titleLayout] : []),
    `      <table>`,
    `        <view>`,
    `          <datasources>`,
    `            <datasource caption='${escapeXml(dsCaption)}' name='${dsName}' />`,
    ...(usedParams.size > 0 ? [`            <datasource name='Parameters' />`] : []),
    `          </datasources>`,
    ...(layout.mapsources
      ? [`          <mapsources>`, `            <mapsource name='Tableau' />`, `          </mapsources>`]
      : []),
    `          <datasource-dependencies datasource='${dsName}'>`,
    depLines,
    `          </datasource-dependencies>`,
    ...(paramDeps ? [paramDeps] : []),
    ...(filterXmlParts.length > 0 ? filterXmlParts : []),
    ...(shelfSortsBlock ? [shelfSortsBlock] : []),
    ...(slicesBlock ? [slicesBlock] : []),
    `          <aggregation value='true' />`,
    `        </view>`,
    styleBlock,
    panes,
    `        <rows${rowsAttr}>${layout.rows}</rows>`,
    `        <cols${colsAttr}>${layout.cols}</cols>`,
    `      </table>`,
    `      <simple-id uuid='{${randomUUID().toUpperCase()}}' />`,
    `    </worksheet>`,
  ].join('\n');

  return { xml, legends };
}

/** Build a resolved dimension pill, applying sensible date-derivation defaults. */
function makeDimPill(name: string, field: DatasourceField | undefined, recipe: ChartRecipe): ResolvedPill {
  const dataType = twbDataType(field);
  const isDate = dataType === 'date' || dataType === 'datetime';
  let dateDerivation: DateDerivation | undefined;
  let continuousDate = false;
  if (isDate) {
    if (recipe.continuousDate) {
      // Trend charts: continuous month truncation (green) — the standard "date over time".
      dateDerivation = 'month';
      continuousDate = true;
    } else {
      // Categorical charts: discrete YEAR is the safe, readable default.
      dateDerivation = 'year';
    }
  }
  return resolvePill({ name, role: 'dimension', dataType, dateDerivation, continuousDate });
}

/** Build a resolved measure pill with an optional number format. `discrete` makes it a
 * blue (ordinal) header pill for detail/crosstab rows. */
function makeMeasurePill(
  m: MeasureRef,
  field: DatasourceField | undefined,
  discrete = false,
  forceAggregated = false,
): ResolvedPill {
  const dataType: TwbDataType = measureDatatype(twbDataType(field));
  const format = resolveMeasureFormat(m);
  return resolvePill({
    name: m.field,
    role: 'measure',
    dataType,
    aggregation: m.aggregation,
    aggregated: m.aggregated === true || forceAggregated,
    format,
    ...(discrete ? { continuous: false } : {}),
  });
}

function resolveMeasureFormat(m: MeasureRef): string | undefined {
  return buildNumberFormat({
    numberFormat: m.numberFormat,
    decimalPlaces: m.decimalPlaces,
    scale: m.scale,
    currencySymbol: m.currencySymbol,
  });
}

/** Default abbreviated number format for a KPI headline value. */
function defaultKpiFormat(m: MeasureRef): string {
  const explicit = resolveMeasureFormat(m);
  if (explicit) return explicit;
  if (looksLikeCurrency(m.field)) {
    return buildNumberFormat({ numberFormat: 'currency', scale: 'millions', decimalPlaces: 1 })!;
  }
  return buildNumberFormat({ numberFormat: 'number', scale: 'millions', decimalPlaces: 1 })!;
}

/** Table style-rule that stamps a number format onto a measure's cell text. */
function numberFormatRule(ref: string, fmt: string): string {
  return [
    `          <style-rule element='cell'>`,
    `            <format attr='text-format' field='${ref}' value='${escapeXml(fmt)}' />`,
    `          </style-rule>`,
  ].join('\n');
}

const MARK_LABELS_RULE = [
  `          <style-rule element='mark'>`,
  `            <format attr='mark-labels-show' value='true' />`,
  `            <format attr='mark-labels-cull' value='true' />`,
  `          </style-rule>`,
].join('\n');

/** Tableau reference-line formula names keyed by our schema's formula enum. */
const REFLINE_FORMULA: Record<string, string> = {
  average: 'average',
  median: 'median',
  sum: 'sum',
  min: 'minimum',
  max: 'maximum',
  total: 'total',
};

/**
 * Assign the ordered dimensions/measures onto shelves + encodings for the chart family.
 * Every ref passed to a shelf/encoding also registers its column-instance (via the
 * dimPill/measPill closures) so the datasource-dependencies stay consistent.
 */
function placeFields(
  recipe: ChartRecipe,
  ws: WorksheetSpec,
  dims: string[],
  measures: MeasureRef[],
  dimPill: (name: string) => ResolvedPill,
  measPill: (m: MeasureRef) => ResolvedPill,
  measDiscPill: (m: MeasureRef) => ResolvedPill,
  dsName: string,
  finalName: string,
): Layout {
  const encodings: Encoding[] = [];
  const styleRules: string[] = [];
  const wantLabels = recipe.showsValueLabels || ws.formatting?.showLabels === true;

  const measureRefs = () => measures.map((m) => measPill(m).ref(dsName));
  const dimRefs = () => dims.map((d) => dimPill(d).ref(dsName));

  // Apply number-format cell rules for any measure that has an explicit format.
  const applyMeasureFormats = () => {
    for (const m of measures) {
      const fmt = resolveMeasureFormat(m);
      if (fmt) styleRules.push(numberFormatRule(measPill(m).ref(dsName), fmt));
    }
  };

  const addValueLabels = (ref: string | undefined) => {
    if (wantLabels && ref) {
      encodings.push({ shelf: 'label', ref });
      styleRules.push(MARK_LABELS_RULE);
    }
  };

  const base = (rows: string, cols: string): Layout => ({
    rows,
    cols,
    encodings,
    markClass: recipe.markClass,
    styleRules,
    mapsources: recipe.isMap,
  });

  switch (recipe.strategy) {
    case 'measureRows_dimCols': {
      const rows = buildShelf(measureRefs(), 'measure');
      const cols = buildShelf(dimRefs(), 'dim');
      if (dims[0] && (recipe.markClass === 'Bar')) encodings.push({ shelf: 'color', ref: dimPill(dims[0]).ref(dsName) });
      else if (dims[1]) encodings.push({ shelf: 'color', ref: dimPill(dims[1]).ref(dsName) });
      applyMeasureFormats();
      addValueLabels(measures[0] ? measPill(measures[0]).ref(dsName) : undefined);
      return base(rows, cols);
    }
    case 'measureCols_dimRows': {
      const cols = buildShelf(measureRefs(), 'measure');
      const rows = buildShelf(dimRefs(), 'dim');
      if (dims[0]) encodings.push({ shelf: 'color', ref: dimPill(dims[0]).ref(dsName) });
      applyMeasureFormats();
      addValueLabels(measures[0] ? measPill(measures[0]).ref(dsName) : undefined);
      return base(rows, cols);
    }
    case 'stacked': {
      const cols = dims[0] ? dimPill(dims[0]).ref(dsName) : '';
      const rows = measures[0] ? measPill(measures[0]).ref(dsName) : '';
      const stackDim = dims[1] ?? dims[0];
      if (stackDim) encodings.push({ shelf: 'color', ref: dimPill(stackDim).ref(dsName) });
      applyMeasureFormats();
      return base(rows, cols);
    }
    case 'sideBySide': {
      const colDims = dims.slice(0, 2).map((d) => dimPill(d).ref(dsName));
      const cols = buildShelf(colDims, 'dim');
      const rows = measures[0] ? measPill(measures[0]).ref(dsName) : '';
      const stackDim = dims[1] ?? dims[0];
      if (stackDim) encodings.push({ shelf: 'color', ref: dimPill(stackDim).ref(dsName) });
      applyMeasureFormats();
      return base(rows, cols);
    }
    case 'dualMeasureAxes': {
      // scatter: measure0 → cols, measure1 → rows, dim → detail (+color for a 2nd dim)
      const cols = measures[0] ? measPill(measures[0]).ref(dsName) : '';
      const rows = measures[1] ? measPill(measures[1]).ref(dsName) : '';
      if (dims[0]) encodings.push({ shelf: 'detail', ref: dimPill(dims[0]).ref(dsName) });
      if (dims[1]) encodings.push({ shelf: 'color', ref: dimPill(dims[1]).ref(dsName) });
      applyMeasureFormats();
      return base(rows, cols);
    }
    case 'pie': {
      if (dims[0]) encodings.push({ shelf: 'color', ref: dimPill(dims[0]).ref(dsName) });
      if (measures[0]) encodings.push({ shelf: 'angle', ref: measPill(measures[0]).ref(dsName) });
      applyMeasureFormats();
      addValueLabels(measures[0] ? measPill(measures[0]).ref(dsName) : undefined);
      return base('', '');
    }
    case 'textTable': {
      if (recipe.allDiscreteRows) {
        // Detail/crosstab: EVERY field (dimensions + measures) discrete on Rows.
        const allRefs = [...dims.map((d) => dimPill(d).ref(dsName)), ...measures.map((m) => measDiscPill(m).ref(dsName))];
        return base(buildShelf(allRefs, 'dim'), '');
      }
      const rows = buildShelf(dimRefs(), 'dim');
      for (const m of measures) encodings.push({ shelf: 'label', ref: measPill(m).ref(dsName) });
      applyMeasureFormats();
      return base(rows, '');
    }
    case 'highlightTable': {
      const rows = dims[0] ? dimPill(dims[0]).ref(dsName) : '';
      const cols = dims[1] ? dimPill(dims[1]).ref(dsName) : '';
      if (measures[0]) {
        encodings.push({ shelf: 'color', ref: measPill(measures[0]).ref(dsName) });
        encodings.push({ shelf: 'label', ref: measPill(measures[0]).ref(dsName) });
      }
      applyMeasureFormats();
      return base(rows, cols);
    }
    case 'treemap': {
      if (measures[0]) {
        encodings.push({ shelf: 'size', ref: measPill(measures[0]).ref(dsName) });
        encodings.push({ shelf: 'color', ref: measPill(measures[0]).ref(dsName) });
      }
      if (dims[0]) encodings.push({ shelf: 'label', ref: dimPill(dims[0]).ref(dsName) });
      applyMeasureFormats();
      return base('', '');
    }
    case 'packedBubble': {
      if (dims[0]) encodings.push({ shelf: 'detail', ref: dimPill(dims[0]).ref(dsName) });
      if (measures[0]) encodings.push({ shelf: 'size', ref: measPill(measures[0]).ref(dsName) });
      if (dims[0]) encodings.push({ shelf: 'color', ref: dimPill(dims[0]).ref(dsName) });
      if (dims[0]) encodings.push({ shelf: 'label', ref: dimPill(dims[0]).ref(dsName) });
      applyMeasureFormats();
      return base('', '');
    }
    case 'map': {
      const rows = `[${dsName}].[Latitude (generated)]`;
      const cols = `[${dsName}].[Longitude (generated)]`;
      const geo = dims.find((d) => GEO_RE.test(d)) ?? dims[0];
      if (geo) encodings.push({ shelf: 'detail', ref: dimPill(geo).ref(dsName) });
      if (recipe.filledMap && measures[0]) encodings.push({ shelf: 'color', ref: measPill(measures[0]).ref(dsName) });
      else if (measures[0]) encodings.push({ shelf: 'size', ref: measPill(measures[0]).ref(dsName) });
      applyMeasureFormats();
      return base(rows, cols);
    }
    case 'gantt': {
      const cols = dims.find((d) => /date|time|year|month/i.test(d)) ?? dims[0];
      const rowDim = dims.find((d) => d !== cols) ?? dims[0];
      applyMeasureFormats();
      return base(rowDim ? dimPill(rowDim).ref(dsName) : '', cols ? dimPill(cols).ref(dsName) : '');
    }
    case 'kpi': {
      return kpiLayout(recipe, ws, measures, measPill, dsName, finalName, styleRules, encodings);
    }
    case 'dual': {
      return dualLayout(recipe, dims, measures, dimPill, measPill, dsName, styleRules);
    }
    default:
      return base(buildShelf(measureRefs(), 'measure'), buildShelf(dimRefs(), 'dim'));
  }
}

/** KPI card: single measure as a big bold value with a caption below (customized-label). */
function kpiLayout(
  recipe: ChartRecipe,
  ws: WorksheetSpec,
  measures: MeasureRef[],
  measPill: (m: MeasureRef) => ResolvedPill,
  dsName: string,
  finalName: string,
  styleRules: string[],
  encodings: Encoding[],
): Layout {
  const m = measures[0];
  if (!m) {
    return { rows: '', cols: '', encodings, markClass: 'Automatic', styleRules };
  }
  const fmt = defaultKpiFormat(m);
  const ref = measPill({ ...m }).ref(dsName);
  // Re-register with the KPI default format applied to the column-instance.
  styleRules.push(numberFormatRule(ref, fmt));
  const title = ws.formatting?.title ?? finalName;
  encodings.push({ shelf: 'label', ref });
  // The line-break run mirrors real Tableau: a leading U+00C6 (Æ) before the &#10;
  // newline keeps the break from being collapsed (Tableau does not display the Æ).
  const paneExtra = [
    `            <customized-label>`,
    `              <formatted-text>`,
    `                <run bold='true' fontcolor='#1b1b1b' fontsize='18'><![CDATA[<${ref}>]]></run>`,
    `                <run>\u00C6&#10;</run>`,
    `                <run bold='true' fontcolor='#1b1b1b' fontsize='12'>${escapeXml(title)}</run>`,
    `              </formatted-text>`,
    `            </customized-label>`,
    `            <style>`,
    `              <style-rule element='cell'>`,
    `                <format attr='text-align' value='center' />`,
    `              </style-rule>`,
    `              <style-rule element='mark'>`,
    `                <format attr='mark-labels-show' value='true' />`,
    `                <format attr='mark-labels-cull' value='true' />`,
    `              </style-rule>`,
    `            </style>`,
  ].join('\n');
  return { rows: '', cols: '', encodings, markClass: 'Automatic', styleRules, paneExtra };
}

/** Dual-axis / combo: two measures folded via [:Measure Names] across synced panes. */
function dualLayout(
  recipe: ChartRecipe,
  dims: string[],
  measures: MeasureRef[],
  dimPill: (name: string) => ResolvedPill,
  measPill: (m: MeasureRef) => ResolvedPill,
  dsName: string,
  styleRules: string[],
): Layout {
  // Needs two measures and a dimension (usually a date) on the axis.
  if (measures.length < 2 || dims.length < 1) {
    // Fall back to a simple multi-measure chart on rows.
    const rows = buildShelf(measures.map((m) => measPill(m).ref(dsName)), 'measure');
    const cols = buildShelf(dims.map((d) => dimPill(d).ref(dsName)), 'dim');
    return { rows, cols, encodings: [], markClass: recipe.markClass, styleRules };
  }
  const m1 = measPill(measures[0]!).ref(dsName);
  const m2 = measPill(measures[1]!).ref(dsName);
  const d = dimPill(dims[0]!).ref(dsName);
  const measureNames = `[${dsName}].[:Measure Names]`;
  const paneColor =
    `            <encodings>\n              <color column='${measureNames}' />\n            </encodings>`;
  const pane = (attrs: string): string =>
    [
      `          <pane selection-relaxation-option='selection-relaxation-allow'${attrs}>`,
      `            <view>`,
      `              <breakdown value='auto' />`,
      `            </view>`,
      `            <mark class='${recipe.markClass}' />`,
      paneColor,
      `          </pane>`,
    ].join('\n');
  const panesOverride = [
    `        <panes>`,
    pane(''),
    pane(` id='1' y-axis-name='${m1}'`),
    pane(` id='2' y-axis-name='${m2}'`),
    `        </panes>`,
  ].join('\n');
  for (const m of measures) {
    const fmt = resolveMeasureFormat(m);
    if (fmt) styleRules.push(numberFormatRule(measPill(m).ref(dsName), fmt));
  }
  return {
    rows: `(${m1} + ${m2})`,
    cols: d,
    encodings: [],
    markClass: recipe.markClass,
    panesOverride,
    styleRules,
  };
}
