/**
 * Chart-type registry: maps each {@link ChartType} to a deterministic recipe
 * (Tableau mark class + a field-placement strategy the worksheet renderer switches
 * on). Ported/condensed from the Tableau-Desktop authoring project's registry,
 * derived from real sample workbooks.
 *
 * This is DATA, not XML generation — the placement strategy tells `renderWorksheet`
 * where to put the ordered dimensions/measures and which encodings to emit.
 */
import type { ChartType } from '../../schemas/common.js';

/**
 * How ordered dimensions/measures map onto shelves/encodings.
 *  - measureRows_dimCols : dim(s) → cols, measure(s) → rows        (bar, line, area, histogram…)
 *  - measureCols_dimRows : dim(s) → rows, measure(s) → cols        (horizontal_bar, funnel, bullet)
 *  - stacked             : dim0 → cols, measure → rows, dim1 → color
 *  - sideBySide          : (dim0 / dim1) → cols, measure → rows, dim1 → color
 *  - dualMeasureAxes     : measure0 → cols, measure1 → rows, dim → detail (scatter/bubble-xy)
 *  - dual                : (m0 + m1) → rows via Measure Names, dim → cols (dual_line/axis/combo)
 *  - pie                 : dim → color, measure → angle (wedge-size); rows/cols empty
 *  - textTable           : dims → rows, measures → text
 *  - highlightTable      : dim0 → rows, dim1 → cols, measure → color
 *  - treemap             : measure → size(+color), dim → detail/label; rows/cols empty
 *  - packedBubble        : dim → detail(+color), measure → size; rows/cols empty
 *  - map                 : Lat/Long generated, geo dim → detail (+color/size)
 *  - kpi                 : measure → text; rows/cols empty
 *  - gantt               : date → cols, dim → rows
 */
export type PlaceStrategy =
  | 'measureRows_dimCols'
  | 'measureCols_dimRows'
  | 'stacked'
  | 'sideBySide'
  | 'dualMeasureAxes'
  | 'dual'
  | 'pie'
  | 'textTable'
  | 'highlightTable'
  | 'treemap'
  | 'packedBubble'
  | 'map'
  | 'kpi'
  | 'gantt';

export interface ChartRecipe {
  markClass: string;
  strategy: PlaceStrategy;
  description: string;
  /** Rows/cols left empty (pie/kpi/treemap/bubble). */
  emptyRowsCols: boolean;
  /** Two measures folded onto one axis via [:Measure Names] with panes. */
  dualAxis: boolean;
  /** Date fields on the axis render continuous (green truncation). */
  continuousDate: boolean;
  /** Show value (mark) labels by default. */
  showsValueLabels: boolean;
  /** Uses generated Latitude/Longitude. */
  isMap: boolean;
  /** For filled maps: measure drives color. */
  filledMap?: boolean;
  /** Detail/crosstab: place ALL fields (dims + measures) on ROWS as DISCRETE pills. */
  allDiscreteRows?: boolean;
}

export const CHART_REGISTRY: Record<ChartType, ChartRecipe> = {
  bar: { markClass: 'Bar', strategy: 'measureRows_dimCols', description: 'Vertical bar', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: true, isMap: false },
  horizontal_bar: { markClass: 'Bar', strategy: 'measureCols_dimRows', description: 'Horizontal bar', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: true, isMap: false },
  stacked_bar: { markClass: 'Bar', strategy: 'stacked', description: 'Stacked bar', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  side_by_side_bar: { markClass: 'Bar', strategy: 'sideBySide', description: 'Side-by-side bar', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  line: { markClass: 'Line', strategy: 'measureRows_dimCols', description: 'Line', emptyRowsCols: false, dualAxis: false, continuousDate: true, showsValueLabels: false, isMap: false },
  dual_line: { markClass: 'Line', strategy: 'dual', description: 'Dual-line', emptyRowsCols: false, dualAxis: true, continuousDate: true, showsValueLabels: false, isMap: false },
  area: { markClass: 'Area', strategy: 'measureRows_dimCols', description: 'Area', emptyRowsCols: false, dualAxis: false, continuousDate: true, showsValueLabels: false, isMap: false },
  scatter: { markClass: 'Shape', strategy: 'dualMeasureAxes', description: 'Scatter', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  pie: { markClass: 'Pie', strategy: 'pie', description: 'Pie', emptyRowsCols: true, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  donut: { markClass: 'Pie', strategy: 'pie', description: 'Donut', emptyRowsCols: true, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  text_table: { markClass: 'Automatic', strategy: 'textTable', description: 'Text table', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  highlight_table: { markClass: 'Square', strategy: 'highlightTable', description: 'Highlight table', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  heatmap: { markClass: 'Square', strategy: 'highlightTable', description: 'Heatmap', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  treemap: { markClass: 'Automatic', strategy: 'treemap', description: 'Treemap', emptyRowsCols: true, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  map: { markClass: 'Automatic', strategy: 'map', description: 'Symbol map', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: true },
  symbol_map: { markClass: 'Automatic', strategy: 'map', description: 'Symbol map', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: true },
  filled_map: { markClass: 'Automatic', strategy: 'map', description: 'Filled map', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: true, filledMap: true },
  bullet: { markClass: 'Bar', strategy: 'measureCols_dimRows', description: 'Bullet', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  histogram: { markClass: 'Bar', strategy: 'measureRows_dimCols', description: 'Histogram', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  box_plot: { markClass: 'Circle', strategy: 'measureRows_dimCols', description: 'Box plot', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  gantt: { markClass: 'Gantt', strategy: 'gantt', description: 'Gantt', emptyRowsCols: false, dualAxis: false, continuousDate: true, showsValueLabels: false, isMap: false },
  funnel: { markClass: 'Bar', strategy: 'measureCols_dimRows', description: 'Funnel', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: true, isMap: false },
  kpi: { markClass: 'Automatic', strategy: 'kpi', description: 'KPI card', emptyRowsCols: true, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  dual_axis: { markClass: 'Automatic', strategy: 'dual', description: 'Dual axis', emptyRowsCols: false, dualAxis: true, continuousDate: false, showsValueLabels: false, isMap: false },
  bubble: { markClass: 'Circle', strategy: 'packedBubble', description: 'Packed bubbles', emptyRowsCols: true, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false },
  bar_line_combo: { markClass: 'Automatic', strategy: 'dual', description: 'Bar + line combo', emptyRowsCols: false, dualAxis: true, continuousDate: true, showsValueLabels: false, isMap: false },
  detail: { markClass: 'Automatic', strategy: 'textTable', description: 'Detail table (all fields discrete on rows)', emptyRowsCols: false, dualAxis: false, continuousDate: false, showsValueLabels: false, isMap: false, allDiscreteRows: true },
};

export function getChartRecipe(chartType: ChartType): ChartRecipe {
  return CHART_REGISTRY[chartType] ?? CHART_REGISTRY.bar;
}
