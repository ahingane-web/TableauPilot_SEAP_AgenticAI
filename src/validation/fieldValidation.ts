/**
 * Field validation: every field a plan references MUST exist in the locked
 * datasource's live metadata (or be a calculated field the plan itself defines).
 * This is what prevents the classic "the datasource has no field named Revenue"
 * failure — we catch it before any authoring and return the available fields.
 */
import type { DashboardPlan } from '../schemas/dashboardPlan.js';
import type { DatasourceMetadata } from '../tableau/types.js';

export interface FieldError {
  location: string;
  field: string;
  message: string;
}

export interface FieldValidationResult {
  valid: boolean;
  errors: FieldError[];
  availableDimensions: string[];
  availableMeasures: string[];
  availableDates: string[];
}

/** Extract bracketed field tokens from a Tableau calc formula, e.g. [Sales]. */
export function extractFormulaFields(formula: string): string[] {
  const out: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Normalize a field name for case/whitespace-insensitive existence checks. */
function normalizeKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function validatePlanFields(plan: DashboardPlan, metadata: DatasourceMetadata): FieldValidationResult {
  const realFields = metadata.fields.map((f) => f.name);
  const calcNames = [
    ...plan.calculatedFields.map((c) => c.name),
    ...plan.worksheets.flatMap((w) => w.calculations.map((c) => c.name)),
  ];
  // Case/whitespace-insensitive existence set (Tableau treats names case-insensitively,
  // and metadata occasionally differs from a plan by incidental casing/whitespace).
  const known = new Set<string>([...realFields, ...calcNames].map(normalizeKey));
  const isKnown = (field: string): boolean => known.has(normalizeKey(field));
  const errors: FieldError[] = [];

  const check = (field: string | undefined, location: string): void => {
    if (!field) return;
    if (!isKnown(field)) {
      errors.push({
        location,
        field,
        message: `The selected datasource does not contain a field named "${field}".`,
      });
    }
  };

  // Datasource-level filters (+ Top-N ranking measure).
  plan.filters.forEach((f, i) => {
    check(f.field, `filters[${i}]`);
    if (f.topN) check(f.topN.byMeasure, `filters[${i}].topN.byMeasure`);
  });

  // Worksheets
  plan.worksheets.forEach((ws, wi) => {
    ws.dimensions.forEach((d, i) => check(d, `worksheets[${wi}].dimensions[${i}]`));
    ws.measures.forEach((m, i) => check(m.field, `worksheets[${wi}].measures[${i}]`));
    if (ws.kpiMeasure) check(ws.kpiMeasure.field, `worksheets[${wi}].kpiMeasure`);
    ws.filters.forEach((f, i) => {
      check(f.field, `worksheets[${wi}].filters[${i}]`);
      if (f.topN) check(f.topN.byMeasure, `worksheets[${wi}].filters[${i}].topN.byMeasure`);
    });
    (ws.sorting ?? []).forEach((s, i) => {
      check(s.field, `worksheets[${wi}].sorting[${i}].field`);
      if (s.byField) check(s.byField, `worksheets[${wi}].sorting[${i}].byField`);
    });
    (ws.referenceLines ?? []).forEach((rl, i) => check(rl.field, `worksheets[${wi}].referenceLines[${i}].field`));
    if (ws.colorMap) check(ws.colorMap.field, `worksheets[${wi}].colorMap.field`);
    if (ws.formatting?.colorField) check(ws.formatting.colorField, `worksheets[${wi}].formatting.colorField`);
  });

  // Calculated fields reference only real fields or previously-defined calcs.
  const validateCalc = (name: string, formula: string, location: string): void => {
    for (const ref of extractFormulaFields(formula)) {
      if (!isKnown(ref)) {
        errors.push({
          location,
          field: ref,
          message: `Calculated field "${name}" references unknown field "${ref}".`,
        });
      }
    }
  };
  plan.calculatedFields.forEach((c, i) => validateCalc(c.name, c.formula, `calculatedFields[${i}]`));
  plan.worksheets.forEach((ws, wi) =>
    ws.calculations.forEach((c, i) => validateCalc(c.name, c.formula, `worksheets[${wi}].calculations[${i}]`)),
  );

  // Dashboard layout items must reference worksheets the plan actually defines, else the
  // board would point at a missing/blank sheet (Tableau rejects such workbooks).
  const worksheetNames = new Set(plan.worksheets.map((w) => normalizeKey(w.name)));
  plan.dashboards.forEach((board, bi) => {
    board.items.forEach((it, i) => {
      if (it.worksheet && !worksheetNames.has(normalizeKey(it.worksheet))) {
        errors.push({
          location: `dashboards[${bi}].items[${i}].worksheet`,
          field: it.worksheet,
          message: `Dashboard "${board.name}" references a worksheet "${it.worksheet}" that the plan does not define.`,
        });
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
    availableDimensions: metadata.dimensions.map((f) => f.name),
    availableMeasures: metadata.measures.map((f) => f.name),
    availableDates: metadata.dates.map((f) => f.name),
  };
}
