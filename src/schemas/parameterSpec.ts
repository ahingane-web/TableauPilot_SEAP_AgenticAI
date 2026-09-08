import { z } from 'zod';

/** A Tableau parameter the planner proposes (e.g. Top N, Metric Selector). */
export const ParameterSpecSchema = z.object({
  name: z.string().min(1),
  dataType: z.enum(['integer', 'float', 'string', 'boolean', 'date']),
  currentValue: z.string().optional(),
  /** Allowed values when the parameter is a fixed list. */
  allowableValues: z.array(z.string()).optional(),
  /** Range for numeric parameters. */
  range: z
    .object({ min: z.number(), max: z.number(), step: z.number().optional() })
    .optional(),
  description: z.string().optional(),
});
export type ParameterSpec = z.infer<typeof ParameterSpecSchema>;
