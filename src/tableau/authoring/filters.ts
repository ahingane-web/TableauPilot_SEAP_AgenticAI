/**
 * Filter compilation for interactive dashboards.
 *
 * Turns a validated {@link FilterSpec} into the worksheet-level `<filter>` XML plus the
 * refs/column declarations a dashboard filter CONTROL needs to bind. Patterns mirror the
 * Tableau-Desktop authoring project (categorical member/union or "show all", quantitative
 * in-range) so the generated workbook opens cleanly and the panel drives the sheets.
 *
 * "Apply to all worksheets" is achieved the way Tableau stores it: a shared
 * `filter-group` + `context='true'` on the SAME filter emitted onto every target
 * worksheet — there is no dashboard-level state for it.
 */
import type { FilterSpec } from '../../schemas/filterSpec.js';
import type { DatasourceField, DatasourceMetadata } from '../types.js';
import { escapeXml, twbDataType } from './xml.js';
import { resolvePill, type ResolvedPill, type TwbDataType } from './pill.js';

/** A filter resolved against real metadata, ready to emit on a worksheet + panel. */
export interface ResolvedFilter {
  spec: FilterSpec;
  field: string;
  isMeasure: boolean;
  pill: ResolvedPill;
  /** Shelf/control reference `[dsName].[instance]`. */
  ref: string;
  instanceName: string;
  columnDecl: string;
  columnInstanceDecl: string;
  /** Whether this filter can render a meaningful `<filter>` element. */
  hasFilterXml: boolean;
  /** True for a ranked Top-N / Bottom-N filter (`operator === 'top_n'`). */
  isTopN: boolean;
  /** Caption of the parameter driving N, when the Top-N is parameter-driven. */
  topNParamCaption?: string;
  /**
   * Extra base `<column>` declarations (12-space indent) this filter needs in the
   * worksheet's datasource-dependencies — e.g. the ranking measure for a Top-N.
   */
  extraColumnDecls: string[];
  /**
   * The ranking measure's fully-resolved pill for a Top-N filter. The worksheet
   * renderer registers it so BOTH the measure's `<column>` AND its
   * `<column-instance>` (e.g. `[sum:Sales:qk]`) are declared — without the
   * instance decl Tableau silently fails to rank, so the Top-N does nothing.
   */
  rankMeasurePill?: ResolvedPill;
  /**
   * Emit the `<filter>` element (10-space indent) for a worksheet's `<view>`.
   * `context`/`filterGroup` tie the same filter across sheets for apply-to-all.
   * `topNCount` overrides a Top-N filter's count (e.g. a `[Parameters].[Parameter k]` ref).
   */
  buildFilterXml(opts?: { context?: boolean; filterGroup?: number; topNCount?: string }): string;
  /** The `<slices>` child column line (categorical filters only). */
  sliceLine?: string;
}

/** Aggregation → Tableau function name used in a Top-N ranking expression. */
const AGG_FN: Record<string, string> = {
  sum: 'SUM',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
  count: 'COUNT',
  count_distinct: 'COUNTD',
  median: 'MEDIAN',
  none: 'SUM',
};

const CATEGORICAL_OPERATORS = new Set([
  'equals',
  'not_equals',
  'in',
  'not_in',
  'contains',
  'starts_with',
  'ends_with',
  'null',
  'not_null',
  'date',
  'relative_date',
  'top_n',
]);

/** Resolve a filter spec, or return null when the field is unknown. */
export function resolveFilter(
  spec: FilterSpec,
  metadata: DatasourceMetadata,
  dsName: string,
): ResolvedFilter | null {
  const field: DatasourceField | undefined = metadata.fields.find((f) => f.name === spec.field);
  if (!field) return null;

  const isMeasure = field.role === 'measure';
  const isDate = field.isDate || twbDataType(field) === 'date' || twbDataType(field) === 'datetime';
  const numericValues = spec.values.map((v) => Number(v)).filter((n) => !Number.isNaN(n));

  const pill = isMeasure
    ? resolvePill({ name: field.name, role: 'measure', dataType: measureType(field), aggregation: 'sum' })
    : resolvePill({
        name: field.name,
        role: 'dimension',
        dataType: twbDataType(field),
        // Filters target the DISCRETE (blue) date part so members match.
        dateDerivation: isDate ? 'year' : undefined,
        continuousDate: false,
      });

  const ref = pill.ref(dsName);
  const memberLevel = `[${pill.instanceName}]`;
  const quote = twbDataType(field) === 'string';

  // A ranked Top-N / Bottom-N filter over a dimension, ranked by a measure aggregate.
  const isTopN = spec.operator === 'top_n' && !!spec.topN && !isMeasure;
  const extraColumnDecls: string[] = [];
  let rankMeasureExpr = '';
  let rankMeasurePill: ResolvedPill | undefined;
  if (isTopN && spec.topN) {
    const measField = metadata.fields.find((f) => f.name === spec.topN!.byMeasure);
    if (measField) {
      // Declare BOTH the ranking measure's base column AND its column-instance
      // (e.g. `[sum:Sales:qk]`) so the `SUM([Sales])` order expression resolves.
      // Matching Version2's `deps.add(measurePill)`: an instance-less decl makes
      // Tableau silently skip the ranking (Top-N appears to "not work").
      rankMeasurePill = resolvePill({
        name: measField.name,
        role: 'measure',
        dataType: measureType(measField),
        aggregation: spec.topN.measureAggregation && spec.topN.measureAggregation !== 'none' ? spec.topN.measureAggregation : 'sum',
      });
      extraColumnDecls.push(`            ${rankMeasurePill.columnDecl}`);
    }
    const aggFn = AGG_FN[spec.topN.measureAggregation] ?? 'SUM';
    rankMeasureExpr = `${aggFn}([${escapeXml(spec.topN.byMeasure)}])`;
  }

  // Decide what kind of <filter> we can emit.
  const rangeFilter = isMeasure && numericValues.length > 0;
  const memberFilter = !isTopN && !isMeasure && spec.values.length > 0 && CATEGORICAL_OPERATORS.has(spec.operator);
  const showAllFilter = !isTopN && !isMeasure && !memberFilter; // interactive control with all members
  const hasFilterXml = isTopN || rangeFilter || memberFilter || showAllFilter;

  const buildFilterXml = (opts?: { context?: boolean; filterGroup?: number; topNCount?: string }): string => {
    const ctxAttr = opts?.context ? " context='true'" : '';
    const groupAttr = opts?.filterGroup != null ? ` filter-group='${opts.filterGroup}'` : '';
    const attrs = `${ctxAttr}${groupAttr}`;

    if (isTopN && spec.topN) {
      const dir = spec.topN.direction === 'bottom' ? 'ASC' : 'DESC';
      const end = spec.topN.direction === 'bottom' ? 'bottom' : 'top';
      const count = opts?.topNCount ?? String(spec.topN.n);
      return [
        `          <filter class='categorical' column='${ref}'${attrs}>`,
        `            <groupfilter count='${count}' end='${end}' function='end' units='records' user:ui-marker='end' user:ui-top-by-field='true'>`,
        `              <groupfilter direction='${dir}' expression='${rankMeasureExpr}' function='order' user:ui-marker='order'>`,
                `                <groupfilter function='level-members' level='${memberLevel}' user:ui-manual-selection='true' user:ui-manual-selection-all-when-empty='true' user:ui-manual-selection-is-empty='true' user:ui-marker='enumerate' />`,
        `              </groupfilter>`,
        `            </groupfilter>`,
        `          </filter>`,
      ].join('\n');
    }

    if (rangeFilter) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      return [
        `          <filter class='quantitative' column='${ref}'${attrs} included-values='in-range'>`,
        `            <min>${min}</min>`,
        `            <max>${max}</max>`,
        `          </filter>`,
      ].join('\n');
    }

    if (memberFilter) {
      const members = spec.values.map((v) =>
        quote ? `&quot;${escapeXml(String(v))}&quot;` : escapeXml(String(v)),
      );
      if (members.length === 1) {
        return [
          `          <filter class='categorical' column='${ref}'${attrs}>`,
          `            <groupfilter function='member' level='${memberLevel}' member='${members[0]}' user:ui-domain='database' user:ui-enumeration='inclusive' user:ui-marker='enumerate' />`,
          `          </filter>`,
        ].join('\n');
      }
      const inner = members
        .map((m) => `              <groupfilter function='member' level='${memberLevel}' member='${m}' />`)
        .join('\n');
      return [
        `          <filter class='categorical' column='${ref}'${attrs}>`,
        `            <groupfilter function='union' user:ui-domain='database' user:ui-enumeration='inclusive' user:ui-marker='enumerate'>`,
        inner,
        `            </groupfilter>`,
        `          </filter>`,
      ].join('\n');
    }

    // Show-all interactive categorical filter (defaults to all members).
    return [
      `          <filter class='categorical' column='${ref}'${attrs}>`,
      `            <groupfilter function='level-members' level='${memberLevel}' user:ui-enumeration='all' user:ui-marker='enumerate' />`,
      `          </filter>`,
    ].join('\n');
  };

  return {
    spec,
    field: field.name,
    isMeasure,
    pill,
    ref,
    instanceName: pill.instanceName,
    columnDecl: pill.columnDecl,
    columnInstanceDecl: pill.columnInstanceDecl,
    hasFilterXml,
    isTopN,
    topNParamCaption: isTopN ? spec.topN?.nParameter : undefined,
    extraColumnDecls,
    rankMeasurePill,
    buildFilterXml,
    // A Top-N still slices on its dimension member level.
    sliceLine: !isMeasure ? `            <column>${ref}</column>` : undefined,
  };
}

function measureType(field: DatasourceField): TwbDataType {
  const t = twbDataType(field);
  return t === 'string' ? 'real' : t;
}
