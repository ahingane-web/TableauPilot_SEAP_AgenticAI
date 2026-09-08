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

export function validatePlanFields(plan: DashboardPlan, metadata: DatasourceMetadata): FieldValidationResult {
  const realFields = new Set(metadata.fields.map((f) => f.name));
  const calcNames = new Set<string>([
    ...plan.calculatedFields.map((c) => c.name),
    ...plan.worksheets.flatMap((w) => w.calculations.map((c) => c.name)),
  ]);
  const known = new Set<string>([...realFields, ...calcNames]);
  const errors: FieldError[] = [];

  const check = (field: string, location: string): void => {
    if (!known.has(field)) {
      errors.push({
        location,
        field,
        message: `The selected datasource does not contain a field named "${field}".`,
      });
    }
  };

  // Datasource-level filters
  plan.filters.forEach((f, i) => check(f.field, `filters[${i}]`));

  // Worksheets
  plan.worksheets.forEach((ws, wi) => {
    ws.dimensions.forEach((d, i) => check(d, `worksheets[${wi}].dimensions[${i}]`));
    ws.measures.forEach((m, i) => check(m.field, `worksheets[${wi}].measures[${i}]`));
    if (ws.kpiMeasure) check(ws.kpiMeasure.field, `worksheets[${wi}].kpiMeasure`);
    ws.filters.forEach((f, i) => check(f.field, `worksheets[${wi}].filters[${i}]`));
    (ws.sorting ?? []).forEach((s, i) => {
      check(s.field, `worksheets[${wi}].sorting[${i}].field`);
      if (s.byField) check(s.byField, `worksheets[${wi}].sorting[${i}].byField`);
    });
  });

  // Calculated fields reference only real fields or previously-defined calcs.
  const validateCalc = (name: string, formula: string, location: string): void => {
    for (const ref of extractFormulaFields(formula)) {
      if (!known.has(ref)) {
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

  return {
    valid: errors.length === 0,
    errors,
    availableDimensions: metadata.dimensions.map((f) => f.name),
    availableMeasures: metadata.measures.map((f) => f.name),
    availableDates: metadata.dates.map((f) => f.name),
  };
}
