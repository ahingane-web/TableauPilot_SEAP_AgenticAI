/**
 * Builds Tableau number-format strings from structured options.
 *
 * Tableau stores number formats as a custom pattern with an optional negative
 * section, e.g. a currency-in-millions Sales measure:
 *
 *     c"$"#,##0,,.0M;-"$"#,##0,,.0M
 *
 * Convention:
 *   - `c"$"`     currency with a `$` literal (the `c` prefix marks a currency
 *                custom format; the negative section repeats just `-"$"`)
 *   - `#,##0`    integer part with thousands separators
 *   - trailing `,` before the decimal = divide by 1000 each (one `,` → K,
 *                two `,,` → M)
 *   - `.0`/`.00` decimal places
 *   - `K`/`M`    literal scale suffix shown after the number
 *   - `;-...`    negative section
 *
 * Ported from the Tableau-Desktop authoring project so the cloud generator can
 * emit the same author-grade formatting.
 */
import type { NumberFormatKind, NumberScale } from '../../schemas/common.js';

export interface NumberFormatInput {
  numberFormat?: NumberFormatKind;
  decimalPlaces?: number;
  scale?: NumberScale;
  /** Currency symbol/literal (default `$`). Only used for `currency`. */
  currencySymbol?: string;
}

/** `.00` for n=2, `` for n=0. */
function decimals(n: number): string {
  return n > 0 ? '.' + '0'.repeat(n) : '';
}

/** True when any structured number-format option was actually requested. */
export function hasNumberFormat(o?: NumberFormatInput | null): boolean {
  if (!o) return false;
  return (
    o.numberFormat != null ||
    o.decimalPlaces != null ||
    (o.scale != null && o.scale !== 'none') ||
    (o.currencySymbol != null && o.currencySymbol !== '')
  );
}

/**
 * Produces a Tableau format string from structured options, or `undefined` when
 * nothing was requested. Currency/number honor `scale` (K/M) and `decimalPlaces`;
 * percentage/scientific honor `decimalPlaces` only.
 */
export function buildNumberFormat(o?: NumberFormatInput | null): string | undefined {
  if (!hasNumberFormat(o)) return undefined;
  const opts = o as NumberFormatInput;
  const kind: NumberFormatKind = opts.numberFormat ?? 'number';

  if (kind === 'percentage') {
    const body = `0${decimals(opts.decimalPlaces ?? 1)}%`;
    return `${body};-${body}`;
  }
  if (kind === 'scientific') {
    const body = `0${decimals(opts.decimalPlaces ?? 2)}E+00`;
    return `${body};-${body}`;
  }

  // currency | number
  let scaleCommas = '';
  let scaleSuffix = '';
  if (opts.scale === 'thousands') {
    scaleCommas = ',';
    scaleSuffix = 'K';
  } else if (opts.scale === 'millions') {
    scaleCommas = ',,';
    scaleSuffix = 'M';
  }
  const scaled = opts.scale === 'thousands' || opts.scale === 'millions';
  const dp = opts.decimalPlaces ?? (scaled ? 1 : kind === 'currency' ? 2 : 0);
  const numBody = `#,##0${scaleCommas}${decimals(dp)}${scaleSuffix}`;

  if (kind === 'currency') {
    // Sanitize the symbol: it lives inside a double-quoted literal.
    const sym = `"${(opts.currencySymbol ?? '$').replace(/"/g, '')}"`;
    return `c${sym}${numBody};-${sym}${numBody}`;
  }
  return `${numBody};-${numBody}`;
}

/** Field/measure name heuristics that imply currency formatting. */
const CURRENCY_NAME_RE = /\b(sales|profit|revenue|cost|price|amount|income|expense|budget|margin|spend|value)\b/i;

/** True when a measure name suggests a monetary value. */
export function looksLikeCurrency(name: string): boolean {
  return CURRENCY_NAME_RE.test(name);
}
