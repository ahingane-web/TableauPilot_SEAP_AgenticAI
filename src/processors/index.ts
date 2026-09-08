/**
 * Processors / middleware.
 *
 * Two flavors live here:
 *  1. `secretProtectionProcessor` — a Mastra agent input processor (LLM boundary).
 *  2. Guard functions (re-exported) — deterministic middleware enforced in the
 *     service/workflow/route layers: datasource guard, project guard, approval
 *     guard, output validation (Zod), and error sanitization.
 *
 * Keeping the guards as plain functions (rather than only LLM processors) means the
 * hard safety rails run regardless of what the model does.
 */
export { secretProtectionProcessor } from './secretProtection.js';

// Deterministic guards (datasource lock, target-project match, approval).
export { assertDatasourceLock, assertProjectMatch, assertApproved, hashPlan } from '../validation/guards.js';

// Output validation — all AI structured output is parsed against Zod before use.
export { DashboardPlanSchema, DashboardPlanDraftSchema } from '../schemas/dashboardPlan.js';

// Error sanitization — used at every boundary that surfaces errors.
export { sanitizeError } from '../utils/errors.js';
