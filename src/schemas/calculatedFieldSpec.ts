import { z } from 'zod';

/**
 * A calculated field the planner proposes. `formula` uses Tableau calc syntax and
 * references only real fields (validated against live metadata + shown to the user
 * for approval before creation).
 */
export const CalculatedFieldSpecSchema = z.object({
  name: z.string().min(1),
  formula: z.string().min(1),
  /** Fields referenced by the formula — extracted for validation and display. */
  referencedFields: z.array(z.string()).default([]),
  role: z.enum(['dimension', 'measure']).default('measure'),
  description: z.string().optional(),
});
export type CalculatedFieldSpec = z.infer<typeof CalculatedFieldSpecSchema>;
