/**
 * Calculated-field internalization.
 *
 * A workbook built on a PUBLISHED datasource must DEFINE every calculated field it uses
 * LOCALLY — with its `<calculation>` formula and a UNIQUE internal name (`Calculation_N`,
 * caption = display name) — exactly like a real Tableau workbook (see sample_workbook.twb,
 * where "Profit Ratio" is `name='[Calculation_1368…]' caption='Profit Ratio'`).
 *
 * Why: if a calculated field is referenced by its DISPLAY name and that name matches a
 * field the datasource already defines (e.g. an existing "Profit Margin %"), Tableau rejects
 * the publish ("field is already defined by data source") and the field ends up as an empty
 * physical column → the chart renders BLANK. Giving every calc a unique internal name means
 * it never collides, always carries its formula, and always renders.
 *
 * This module rewrites a plan so every calculated-field REFERENCE (in dimensions, measures,
 * filters, sorting, reference lines, color maps, colorField, and calc-to-calc formulas) uses
 * the unique internal name, and returns the list of calc definitions to emit. Datasource-
 * defined calculated fields (whose formula we read from the Metadata API) are internalized
 * too, so referencing one renders instead of going blank.
 */
import type { DashboardPlan } from '../../schemas/dashboardPlan.js';
import type { MeasureRef } from '../../schemas/worksheetSpec.js';
import type { FilterSpec } from '../../schemas/filterSpec.js';
import type { DatasourceMetadata } from '../types.js';
import { escapeXml, localName } from './xml.js';
import { isAggregateFormula } from './pill.js';

/** A calculated field the generated workbook defines locally. */
export interface LocalCalc {
  /** Unique internal name that never collides with a datasource field (e.g. `Calculation_1`). */
  internalName: string;
  /** Human-facing display name (Tableau `caption`). */
  caption: string;
  /** Tableau formula (calc-to-calc references already rewritten to internal names). */
  formula: string;
  role: 'dimension' | 'measure';
  /** True when the formula is already aggregated (top-level SUM/AVG/…) → derivation User. */
  aggregated: boolean;
}

export interface CalcInternalization {
  /** The plan with every calc reference rewritten to its internal name; `calculatedFields`
   * and per-worksheet `calculations` are emptied (they are now carried by `calcs`). */
  plan: DashboardPlan;
  /** Calc definitions to emit as local `<column><calculation/></column>` blocks. */
  calcs: LocalCalc[];
}

/** Normalize a field name for collision comparison (trim, collapse whitespace, lowercase). */
function norm(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const FIELD_REF_RE = /\[([^\]]+)\]/g;

/** Extract the `[Field]` tokens referenced by a Tableau formula. */
export function extractFieldRefs(formula: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  FIELD_REF_RE.lastIndex = 0;
  while ((m = FIELD_REF_RE.exec(formula)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Does this datasource field come from a datasource-defined CALCULATED field? */
function isDsCalc(fieldType: string | undefined): boolean {
  return /calculated/i.test(fieldType ?? '');
}

/** Collect every field name referenced anywhere in the plan (by display name). */
function collectReferencedNames(plan: DashboardPlan): Set<string> {
  const s = new Set<string>();
  const addFilter = (f: FilterSpec): void => {
    s.add(f.field);
    if (f.topN) s.add(f.topN.byMeasure);
  };
  for (const ws of plan.worksheets) {
    ws.dimensions.forEach((d) => s.add(d));
    ws.measures.forEach((m) => s.add(m.field));
    if (ws.kpiMeasure) s.add(ws.kpiMeasure.field);
    ws.filters.forEach(addFilter);
    (ws.sorting ?? []).forEach((so) => {
      s.add(so.field);
      if (so.byField) s.add(so.byField);
    });
    (ws.referenceLines ?? []).forEach((r) => s.add(r.field));
    if (ws.colorMap) s.add(ws.colorMap.field);
    if (ws.formatting?.colorField) s.add(ws.formatting.colorField);
  }
  plan.filters.forEach(addFilter);
  return s;
}

interface Def {
  caption: string;
  formula: string;
  role: 'dimension' | 'measure';
}

/**
 * Rewrite a plan so every calculated field it uses is referenced by a unique internal name,
 * and return the calc definitions to emit locally. Includes both planner-created calcs and
 * any referenced datasource-defined calculated field (using its Metadata-API formula).
 */
export function internalizeCalcs(plan: DashboardPlan, metadata: DatasourceMetadata): CalcInternalization {
  // Datasource-defined calculated fields (with a captured formula), by normalized name.
  const dsCalcByKey = new Map<string, { name: string; formula: string; role: 'dimension' | 'measure' }>();
  for (const f of metadata.fields) {
    if (isDsCalc(f.fieldType) && f.formula) {
      dsCalcByKey.set(norm(f.name), {
        name: f.name,
        formula: f.formula,
        role: f.role === 'dimension' ? 'dimension' : 'measure',
      });
    }
  }
  const dsFieldKeys = new Set(metadata.fields.map((f) => norm(f.name)));

  const referenced = collectReferencedNames(plan);

  // Build the definition set keyed by normalized display name. A datasource-defined calc is
  // AUTHORITATIVE (use its formula, avoid divergence); otherwise use the planner's calc.
  const defs = new Map<string, Def>();
  const addDef = (caption: string, formula: string, role: 'dimension' | 'measure'): void => {
    const key = norm(caption);
    if (!defs.has(key)) defs.set(key, { caption, formula, role });
  };
  for (const name of referenced) {
    const dsc = dsCalcByKey.get(norm(name));
    if (dsc) addDef(dsc.name, dsc.formula, dsc.role);
  }
  for (const c of [...plan.calculatedFields, ...plan.worksheets.flatMap((w) => w.calculations)]) {
    if (dsCalcByKey.has(norm(c.name))) continue; // datasource version wins
    addDef(c.name, c.formula, c.role === 'dimension' ? 'dimension' : 'measure');
  }

  if (defs.size === 0) {
    return { plan: { ...plan, calculatedFields: [] }, calcs: [] };
  }

  // Assign unique internal names that collide with neither a datasource field nor each other.
  const nameByKey = new Map<string, string>(); // normDisplay -> internalName
  let seq = 0;
  for (const key of defs.keys()) {
    let internal: string;
    do {
      internal = `Calculation_${++seq}`;
    } while (dsFieldKeys.has(norm(internal)));
    nameByKey.set(key, internal);
  }

  const remapName = (name: string): string => nameByKey.get(norm(name)) ?? name;
  const remapFormula = (formula: string): string =>
    formula.replace(FIELD_REF_RE, (whole, inner: string) => {
      const internal = nameByKey.get(norm(inner));
      return internal ? `[${internal}]` : whole;
    });

  const calcs: LocalCalc[] = [];
  for (const [key, def] of defs) {
    const internalName = nameByKey.get(key)!;
    const formula = remapFormula(def.formula);
    calcs.push({
      internalName,
      caption: def.caption,
      formula,
      role: def.role,
      aggregated: def.role !== 'dimension' && isAggregateFormula(def.formula),
    });
  }
  const aggregatedInternal = new Set(calcs.filter((c) => c.aggregated).map((c) => c.internalName));

  // ---- Rewrite the plan's references to internal names ----------------------
  const p: DashboardPlan = structuredClone(plan);
  const remapMeasure = (m: MeasureRef): void => {
    m.field = remapName(m.field);
    if (aggregatedInternal.has(m.field)) m.aggregated = true;
  };
  const remapFilter = (f: FilterSpec): void => {
    f.field = remapName(f.field);
    if (f.topN) f.topN.byMeasure = remapName(f.topN.byMeasure);
  };
  for (const ws of p.worksheets) {
    ws.dimensions = ws.dimensions.map(remapName);
    ws.measures.forEach(remapMeasure);
    if (ws.kpiMeasure) remapMeasure(ws.kpiMeasure);
    ws.filters.forEach(remapFilter);
    (ws.sorting ?? []).forEach((so) => {
      so.field = remapName(so.field);
      if (so.byField) so.byField = remapName(so.byField);
    });
    (ws.referenceLines ?? []).forEach((r) => {
      r.field = remapName(r.field);
    });
    if (ws.colorMap) ws.colorMap.field = remapName(ws.colorMap.field);
    if (ws.formatting?.colorField) ws.formatting.colorField = remapName(ws.formatting.colorField);
    ws.calculations = []; // now carried by `calcs`
  }
  p.filters.forEach(remapFilter);
  p.calculatedFields = []; // now carried by `calcs`

  return { plan: p, calcs };
}

/**
 * Render a locally-defined calculated field as a `<column>…<calculation/></column>` block,
 * indented by `indent` spaces. Used both at the datasource level and inside each worksheet's
 * `datasource-dependencies` (matching sample_workbook.twb, where the calc column — with its
 * formula — is redeclared in every worksheet that uses it).
 */
export function buildCalcColumnXml(calc: LocalCalc, indent: string): string {
  const dt = calc.role === 'dimension' ? 'string' : 'real';
  const type = calc.role === 'dimension' ? 'nominal' : 'quantitative';
  const aggAttr = calc.aggregated ? `aggregation='User' ` : '';
  return [
    `${indent}<column ${aggAttr}caption='${escapeXml(calc.caption)}' datatype='${dt}' default-type='${type}' name='${escapeXml(
      localName(calc.internalName),
    )}' role='${calc.role}' type='${type}'>`,
    `${indent}  <calculation class='tableau' formula='${escapeXml(calc.formula)}' />`,
    `${indent}</column>`,
  ].join('\n');
}

/**
 * Render a `<metadata-record>` for a locally-defined calc (remote-type -1, formula attribute),
 * matching sample_workbook.twb. `ordinal` continues the sequence after the physical records.
 */
export function buildCalcMetadataRecord(calc: LocalCalc, ordinal: number): string {
  const localType = calc.role === 'dimension' ? 'string' : 'real';
  const cls = calc.aggregated ? 'measure' : 'column';
  const remote = escapeXml(calc.internalName);
  return [
    `        <metadata-record class='${cls}'>`,
    `          <remote-name>${remote}</remote-name>`,
    `          <remote-type>-1</remote-type>`,
    `          <local-name>${escapeXml(localName(calc.internalName))}</local-name>`,
    `          <parent-name>[sqlproxy]</parent-name>`,
    `          <remote-alias>${remote}</remote-alias>`,
    `          <ordinal>${ordinal}</ordinal>`,
    `          <layered>true</layered>`,
    `          <caption>${escapeXml(calc.caption)}</caption>`,
    `          <local-type>${localType}</local-type>`,
    ...(calc.aggregated ? [`          <aggregation>User</aggregation>`] : []),
    `          <contains-null>true</contains-null>`,
    `          <attributes>`,
    `            <attribute datatype='integer' name='field-type'>0</attribute>`,
    `            <attribute datatype='string' name='formula'>&quot;${escapeXml(calc.formula)}&quot;</attribute>`,
    `          </attributes>`,
    `        </metadata-record>`,
  ].join('\n');
}

/** Physical datasource fields referenced by calc formulas (so they are declared as columns). */
export function calcFormulaDependencies(
  calcs: LocalCalc[],
  metadata: DatasourceMetadata,
): { dimensions: string[]; measures: string[] } {
  const calcKeys = new Set(calcs.map((c) => norm(c.internalName)));
  const byKey = new Map(metadata.fields.map((f) => [norm(f.name), f]));
  const dimensions = new Set<string>();
  const measures = new Set<string>();
  for (const c of calcs) {
    for (const ref of extractFieldRefs(c.formula)) {
      if (calcKeys.has(norm(ref))) continue; // calc-to-calc handled separately
      const f = byKey.get(norm(ref));
      if (!f) continue; // unknown token (literal/function) — skip
      if (f.role === 'dimension') dimensions.add(f.name);
      else measures.add(f.name);
    }
  }
  return { dimensions: [...dimensions], measures: [...measures] };
}
