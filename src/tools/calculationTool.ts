/**
 * Calculation-design tool.
 *
 * Exposes the {@link calculationEngineerAgent} subagent to the main consultant as a
 * single tool. Given a business goal (verified against the LOCKED datasource), it
 * returns STRUCTURED, validated calculated-field specs plus rationale and Tableau
 * configuration notes, ready to drop into a DashboardPlan's `calculatedFields[]` (or a
 * worksheet's `calculations[]`).
 *
 * Lives in its own file (not calcInspectionTools) to avoid a circular import: the
 * subagent imports the inspection tools; this tool imports the subagent.
 */
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { CalculatedFieldSpecSchema } from '../schemas/calculatedFieldSpec.js';
import { TableauService } from '../tableau/index.js';
import { withSpan } from '../observability/index.js';
import { AppError } from '../utils/errors.js';
import type { DatasourceMetadata } from '../tableau/types.js';
import { calculationEngineerAgent } from '../agents/calculationEngineerAgent.js';
import { readSessionId, requireSessionFromContext } from './context.js';
import { validateCalcRefs, type CalcRefProblem } from './calcInspectionTools.js';

/** Structured result the calc-engineer subagent returns. */
export const CalcDesignResultSchema = z.object({
  /** Set ONLY when the requirement is materially ambiguous; then no calcs. */
  clarificationNeeded: z.string().optional(),
  /** Ordered calculated-field specs (helper calcs first, then dependents). */
  calculations: z.array(CalculatedFieldSpecSchema).default([]),
  /** One short line per calculation, explaining what/why. */
  rationale: z.array(z.string()).default([]),
  /** Tableau setup the user must perform (Compute Using, context filter, etc.). */
  configNotes: z.array(z.string()).default([]),
});
export type CalcDesignResult = z.infer<typeof CalcDesignResultSchema>;

/** Formats ref problems as a short feedback block for a re-prompt. */
function formatRefFeedback(problems: CalcRefProblem[]): string {
  return problems
    .map((p) => {
      const parts = p.unknownRefs
        .map((u) => `[${u.ref}]` + (u.suggestions.length ? ` (did you mean: ${u.suggestions.join(', ')})` : ''))
        .join('; ');
      return `- '${p.calcName}' references unknown field(s): ${parts}`;
    })
    .join('\n');
}

/**
 * Validate the subagent's calc references and, if any are unknown, re-prompt it ONCE
 * with the specific unknown fields + suggestions. Returns the corrected result (or the
 * original if it was already clean). `regenerate` is injected so this is unit-testable
 * without a live model.
 */
export async function selfCorrectRefs(
  initial: CalcDesignResult,
  fields: DatasourceMetadata['fields'],
  regenerate: (feedback: string) => Promise<CalcDesignResult>,
  extraKnownNames: string[] = [],
): Promise<CalcDesignResult> {
  if (initial.clarificationNeeded || initial.calculations.length === 0) return initial;
  const problems = validateCalcRefs(initial.calculations, fields, extraKnownNames);
  if (problems.length === 0) return initial;
  return regenerate(formatRefFeedback(problems));
}

/** Build the subagent prompt: goal + verified metadata context. */
function buildPrompt(
  input: { goal: string; tableauEnv?: string; fiscalYearStartMonth?: number },
  md: DatasourceMetadata,
  existingCalcs: string[],
): string {
  const fieldList = md.fields.map((f) => `${f.name} (${f.role}, ${f.dataType})`).join('; ');
  return [
    `Business goal:\n${input.goal}`,
    input.tableauEnv ? `Tableau environment: ${input.tableauEnv}` : '',
    input.fiscalYearStartMonth ? `Fiscal year starts in month: ${input.fiscalYearStartMonth}` : '',
    `\nLocked datasource: ${md.datasourceName}`,
    `Available fields (name (role, dataType)):\n${fieldList}`,
    existingCalcs.length ? `\nExisting calculated fields (reuse instead of duplicating):\n${existingCalcs.join('\n')}` : '',
    `\nUse ONLY the listed fields. Return structured output per your OUTPUT CONTRACT ` +
      `(calculations, rationale, configNotes, or clarificationNeeded).`,
  ]
    .filter(Boolean)
    .join('\n');
}

export const designCalculatedFieldsTool = createTool({
  id: 'design_calculated_fields',
  description:
    'Design simple, correct, production-ready Tableau calculated field(s) from a business goal, verified against the LOCKED datasource. Delegates to the senior calculation-engineer subagent and returns validated calculation specs plus rationale and Tableau configuration notes. Use for non-trivial calcs (LOD, table calcs, period-over-period, cohort/retention, Top N + Others, fiscal, ranking, weighted ratios). Copy the returned calculations into the plan.',
  inputSchema: z.object({
    goal: z.string().describe('The business requirement in natural language.'),
    tableauEnv: z.enum(['desktop', 'cloud_web_authoring']).optional(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  }),
  outputSchema: CalcDesignResultSchema,
  execute: async (input, ctx) => {
    const session = requireSessionFromContext(ctx);
    const sessionId = readSessionId(ctx);
    const lock = session.flow.datasourceLock;
    if (!lock) throw new AppError('DATASOURCE_LOCKED', 'Lock a datasource before designing calculations.');

    return withSpan('tool.design_calculated_fields', {}, async () => {
      const md = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
      const existingCalcs = (session.flow.plan?.calculatedFields ?? []).map((c) => `${c.name}: ${c.formula}`);
      const prompt = buildPrompt(input, md, existingCalcs);
      // Propagate the session so the subagent's read-only tools can resolve it.
      const requestContext = sessionId ? new RequestContext([['sessionId', sessionId]]) : undefined;

      const generate = async (extra = ''): Promise<CalcDesignResult> => {
        const res = await calculationEngineerAgent.generate(prompt + extra, {
          structuredOutput: { schema: CalcDesignResultSchema, jsonPromptInjection: 'system' },
          ...(requestContext ? { requestContext } : {}),
        });
        const obj = (res as { object?: unknown }).object;
        return CalcDesignResultSchema.parse(obj);
      };

      const initial = await generate();
      return selfCorrectRefs(initial, md.fields, (feedback) =>
        generate(
          `\n\nYour previous attempt referenced field(s) that do not exist in the datasource. ` +
            `Fix these and return corrected structured output:\n${feedback}`,
        ),
      );
    });
  },
});
