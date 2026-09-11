/**
 * Read-only inspection tools for the calculation-engineer subagent.
 *
 * These verify field names/types and reuse existing calcs/parameters against the
 * LOCKED published datasource (never a pasted schema). They resolve the server-side
 * session from the Mastra requestContext (sessionId) — no credentials in tool args.
 *
 * Kept separate from `calculationTool.ts` (which imports the subagent) to avoid a
 * circular import: agent → these tools; delegate tool → agent.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TableauService } from '../tableau/index.js';
import { AppError } from '../utils/errors.js';
import { withSpan } from '../observability/index.js';
import { CalculatedFieldSpecSchema } from '../schemas/calculatedFieldSpec.js';
import type { DatasourceField, DatasourceMetadata } from '../tableau/types.js';
import type { Session } from '../vault/session.js';
import { requireSessionFromContext } from './context.js';

/** Fetch the LOCKED datasource's live metadata, or throw an actionable error. */
export async function lockedMetadata(session: Session): Promise<DatasourceMetadata> {
  const lock = session.flow.datasourceLock;
  if (!lock) {
    throw new AppError('DATASOURCE_LOCKED', 'Lock a datasource before inspecting or designing calculations.');
  }
  return TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
}

/** Rank up to 5 close field-name matches for a (possibly wrong) reference. */
export function suggest(name: string, fields: DatasourceField[]): string[] {
  const t = name.toLowerCase();
  return fields
    .map((f) => {
      const n = f.name.toLowerCase();
      const score = n === t ? 1 : n.includes(t) || t.includes(n) ? 0.8 : 0;
      return { name: f.name, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.name);
}

/** One calc whose formula references field name(s) not found in the datasource. */
export interface CalcRefProblem {
  calcName: string;
  unknownRefs: { ref: string; suggestions: string[] }[];
}

/**
 * Validate that every `[field]` a calculation references exists. Known names = real
 * datasource fields, any extra known names (e.g. parameter captions), and the names
 * of the calcs themselves (a calc may reference an earlier helper calc). The literal
 * `[Parameters]` qualifier is ignored.
 */
export function validateCalcRefs(
  calculations: z.infer<typeof CalculatedFieldSpecSchema>[],
  fields: DatasourceField[],
  extraKnownNames: string[] = [],
): CalcRefProblem[] {
  const known = new Set<string>();
  for (const f of fields) known.add(f.name.toLowerCase());
  for (const n of extraKnownNames) known.add(n.toLowerCase());
  for (const c of calculations) known.add(c.name.toLowerCase());

  const problems: CalcRefProblem[] = [];
  for (const c of calculations) {
    const refs = [...c.formula.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!.trim());
    const unknownRefs: { ref: string; suggestions: string[] }[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = ref.toLowerCase();
      if (key === 'parameters' || seen.has(key)) continue;
      seen.add(key);
      if (!known.has(key)) unknownRefs.push({ ref, suggestions: suggest(ref, fields) });
    }
    if (unknownRefs.length) problems.push({ calcName: c.name, unknownRefs });
  }
  return problems;
}

const FieldInfo = z.object({
  name: z.string(),
  role: z.string(),
  dataType: z.string(),
  isDate: z.boolean(),
});

/** List the fields (dimensions/measures/dates) of the locked datasource. */
export const inspectFieldsTool = createTool({
  id: 'inspect_fields',
  description:
    'List the real fields (name, role, dataType) of the LOCKED datasource, grouped into dimensions, measures and dates. Use these exact names in formulas; never invent fields.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    datasourceName: z.string(),
    dimensions: z.array(FieldInfo),
    measures: z.array(FieldInfo),
    dates: z.array(FieldInfo),
  }),
  execute: async (_input, ctx) => {
    const session = requireSessionFromContext(ctx);
    return withSpan('tool.inspect_fields', {}, async () => {
      const md = await lockedMetadata(session);
      const map = (f: DatasourceField) => ({ name: f.name, role: f.role, dataType: f.dataType, isDate: f.isDate });
      return {
        datasourceName: md.datasourceName,
        dimensions: md.dimensions.map(map),
        measures: md.measures.map(map),
        dates: md.dates.map(map),
      };
    });
  },
});

/** Check whether a field exists in the locked datasource; suggest close matches. */
export const validateFieldTool = createTool({
  id: 'validate_field',
  description:
    'Check whether a field exists in the LOCKED datasource (case-insensitive). Returns close matches when it does not. Verify names/types before using them in a formula.',
  inputSchema: z.object({ fieldName: z.string() }),
  outputSchema: z.object({
    exists: z.boolean(),
    field: FieldInfo.optional(),
    suggestions: z.array(z.string()),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    const md = await lockedMetadata(session);
    const field = md.fields.find((f) => f.name.toLowerCase() === input.fieldName.toLowerCase());
    return {
      exists: Boolean(field),
      field: field ? { name: field.name, role: field.role, dataType: field.dataType, isDate: field.isDate } : undefined,
      suggestions: field ? [] : suggest(input.fieldName, md.fields),
    };
  },
});

/** Validate a calculated field: every referenced field must exist in the datasource. */
export const validateCalculationTool = createTool({
  id: 'validate_calculation',
  description:
    'Validate a calculated field against the LOCKED datasource: every [field] it references must exist. The formula is kept verbatim (never rewritten). Returns unknown references with suggestions.',
  inputSchema: z.object({ calculation: CalculatedFieldSpecSchema }),
  outputSchema: z.object({
    valid: z.boolean(),
    errors: z.array(z.object({ ref: z.string(), message: z.string(), suggestions: z.array(z.string()) })),
  }),
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    const md = await lockedMetadata(session);
    const problems = validateCalcRefs([input.calculation], md.fields);
    const errors = (problems[0]?.unknownRefs ?? []).map((u) => ({
      ref: u.ref,
      message: `References unknown field '${u.ref}'.`,
      suggestions: u.suggestions,
    }));
    return { valid: errors.length === 0, errors };
  },
});

/** The read-only tools the calculation engineer subagent is allowed to use. */
export const calcInspectionTools = {
  inspect_fields: inspectFieldsTool,
  validate_field: validateFieldTool,
  validate_calculation: validateCalculationTool,
};
