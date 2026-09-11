/**
 * Deterministic column-instance ("pill") naming.
 *
 * Tableau references fields on shelves as `[<dsId>].[<deriv>:<Field>:<typekey>]`.
 * This module derives the instance name, the `<column>` + `<column-instance>`
 * declarations, and the shelf reference from ONE source of truth so they always
 * agree — which is what makes a generated worksheet render a real visual.
 *
 * Ported/adapted from the Tableau-Desktop authoring project's columnInstance.ts.
 */
import type { Aggregation, DateDerivation } from '../../schemas/common.js';

/** Normalized .twb datatype used across the authoring compiler. */
export type TwbDataType = 'string' | 'integer' | 'real' | 'date' | 'datetime' | 'boolean';

/** How a field is used on a shelf/encoding. */
export interface PillInput {
  /** Field name without brackets, e.g. `Sales`. */
  name: string;
  role: 'dimension' | 'measure';
  dataType: TwbDataType;
  /** Aggregation for measures (defaults to `sum`). */
  aggregation?: Aggregation;
  /**
   * The field is ALREADY aggregated (its formula contains a top-level aggregate),
   * so it is used as `AGG(field)` — derivation `User`, instance `[usr:Name:qk]`.
   */
  aggregated?: boolean;
  /** Date part/truncation for date dimensions. */
  dateDerivation?: DateDerivation;
  /** Whether a date dimension is rendered as a continuous (green) axis. */
  continuousDate?: boolean;
  /** Explicit discrete/continuous override (blue vs green). */
  continuous?: boolean;
  /** Optional number/date format string, emitted as `default-format`. */
  format?: string;
}

/** Fully resolved pill with all XML fragments derived. */
export interface ResolvedPill {
  name: string;
  instanceName: string;
  typeAttr: 'nominal' | 'ordinal' | 'quantitative';
  derivationAttr: string;
  /** `<column .../>` declaration for datasource-dependencies. */
  columnDecl: string;
  /** `<column-instance .../>` declaration for datasource-dependencies. */
  columnInstanceDecl: string;
  /** Shelf reference `[<dsId>].[<instance>]`. */
  ref(dsId: string): string;
}

const AGG_CODE: Record<Aggregation, string> = {
  none: 'none',
  sum: 'sum',
  avg: 'avg',
  count: 'cnt',
  count_distinct: 'ctd',
  min: 'min',
  max: 'max',
  median: 'med',
};

const AGG_DERIVATION: Record<Aggregation, string> = {
  none: 'None',
  sum: 'Sum',
  avg: 'Avg',
  count: 'Count',
  count_distinct: 'CountD',
  min: 'Minimum',
  max: 'Maximum',
  median: 'Median',
};

type RealDeriv = Exclude<DateDerivation, 'none'>;

const DATE_DISCRETE_CODE: Record<RealDeriv, string> = {
  year: 'yr', quarter: 'qr', month: 'mn', week: 'wk',
  day: 'dy', weekday: 'wd', hour: 'hr', minute: 'mi',
};
const DATE_DISCRETE_DERIVATION: Record<RealDeriv, string> = {
  year: 'Year', quarter: 'Quarter', month: 'Month', week: 'Week',
  day: 'Day', weekday: 'Weekday', hour: 'Hour', minute: 'Minute',
};
const DATE_CONTINUOUS_CODE: Record<RealDeriv, string> = {
  year: 'tyr', quarter: 'tqr', month: 'tmn', week: 'twk',
  day: 'tdy', weekday: 'twd', hour: 'thr', minute: 'tmi',
};
const DATE_CONTINUOUS_DERIVATION: Record<RealDeriv, string> = {
  year: 'Year-Trunc', quarter: 'Quarter-Trunc', month: 'Month-Trunc', week: 'Week-Trunc',
  day: 'Day-Trunc', weekday: 'Weekday-Trunc', hour: 'Hour-Trunc', minute: 'Minute-Trunc',
};

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Column-level `type` attribute (independent of derivation). */
function columnTypeAttr(input: PillInput): 'nominal' | 'ordinal' | 'quantitative' {
  if (input.role === 'measure') return 'quantitative';
  if (input.dataType === 'string' || input.dataType === 'boolean') return 'nominal';
  return 'ordinal';
}

function typeKey(typeAttr: ResolvedPill['typeAttr']): 'nk' | 'ok' | 'qk' {
  switch (typeAttr) {
    case 'nominal':
      return 'nk';
    case 'ordinal':
      return 'ok';
    case 'quantitative':
      return 'qk';
  }
}

/**
 * True when a Tableau formula is ALREADY aggregated: it has a top-level aggregate
 * function. Aggregates nested inside an LOD expression (`{FIXED ...}`) do NOT count.
 */
export function isAggregateFormula(formula: string): boolean {
  let cleaned = formula;
  cleaned = cleaned.replace(/\{[^{}]*\}/g, ' ');
  cleaned = cleaned.replace(/\{[^{}]*\}/g, ' ');
  cleaned = cleaned.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
  return /\b(SUM|AVG|COUNT|COUNTD|MIN|MAX|MEDIAN|ATTR|STDEV|STDEVP|VAR|VARP|PERCENTILE|CORR|COVAR|COVARP)\s*\(/i.test(
    cleaned,
  );
}

/** Resolves a pill descriptor from a PillInput. */
export function resolvePill(input: PillInput): ResolvedPill {
  const name = input.name;
  const bracket = `[${name}]`;
  const colType = columnTypeAttr(input);

  let code: string;
  let derivationAttr: string;
  let typeAttr: ResolvedPill['typeAttr'];

  if (input.role === 'measure' && input.aggregated) {
    code = 'usr';
    derivationAttr = 'User';
    typeAttr = input.continuous === false ? 'ordinal' : 'quantitative';
  } else if (input.role === 'measure') {
    const agg: Aggregation = input.aggregation && input.aggregation !== 'none' ? input.aggregation : 'sum';
    code = AGG_CODE[agg];
    derivationAttr = AGG_DERIVATION[agg];
    typeAttr = input.continuous === false ? 'ordinal' : 'quantitative';
  } else if (input.dataType === 'date' || input.dataType === 'datetime') {
    const continuous = input.continuous ?? input.continuousDate ?? false;
    const deriv = input.dateDerivation ?? 'none';
    if (deriv === 'none') {
      code = 'none';
      derivationAttr = 'None';
      typeAttr = continuous ? 'quantitative' : 'ordinal';
    } else if (continuous) {
      code = DATE_CONTINUOUS_CODE[deriv];
      derivationAttr = DATE_CONTINUOUS_DERIVATION[deriv];
      typeAttr = 'quantitative';
    } else {
      code = DATE_DISCRETE_CODE[deriv];
      derivationAttr = DATE_DISCRETE_DERIVATION[deriv];
      typeAttr = 'ordinal';
    }
  } else {
    code = 'none';
    derivationAttr = 'None';
    typeAttr = input.continuous === true ? 'quantitative' : colType;
  }

  const instanceName = `${code}:${name}:${typeKey(typeAttr)}`;
  const bracketInstance = `[${instanceName}]`;
  const formatAttr = input.format ? ` default-format='${xmlEscape(input.format)}'` : '';
  const columnDecl =
    `<column datatype='${input.dataType}'${formatAttr} name='${xmlEscape(bracket)}' ` +
    `role='${input.role}' type='${colType}' />`;
  const columnInstanceDecl =
    `<column-instance column='${xmlEscape(bracket)}' derivation='${derivationAttr}' ` +
    `name='${xmlEscape(bracketInstance)}' pivot='key' type='${typeAttr}' />`;

  return {
    name,
    instanceName,
    typeAttr,
    derivationAttr,
    columnDecl,
    columnInstanceDecl,
    ref: (dsId: string) => `[${dsId}].${xmlEscape(bracketInstance)}`,
  };
}
