/**
 * Dashboard planning service — the bridge between AI *planning* and deterministic
 * *execution*.
 *
 * It asks the agent for a structured DashboardPlan (Zod-enforced), injects the
 * approved publishing target server-side (so the model can't choose a different
 * project), validates every field against live metadata, and stores the plan in
 * session flow state. It NEVER executes authoring — that requires human approval
 * and runs through the guards.
 */
import { RequestContext } from '@mastra/core/request-context';
import { dashboardPlannerAgent } from '../agents/dashboardPlannerAgent.js';
import { DashboardPlanDraftSchema, type DashboardPlanDraft, type DashboardPlan } from '../schemas/dashboardPlan.js';
import type { TextFormat, FitMode } from '../schemas/common.js';
import type { ReferenceLineSpec, ColorMapSpec, GrandTotals } from '../schemas/worksheetSpec.js';
import { TableauService } from '../tableau/index.js';
import type { DatasourceMetadata } from '../tableau/types.js';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { recordEvent, withSpan } from '../observability/index.js';
import { hashPlan } from '../validation/guards.js';
import { validatePlanFields, type FieldValidationResult } from '../validation/fieldValidation.js';
import type { Session } from '../vault/session.js';

const log = logger.child('planning');

export interface PlanningResult {
  plan: DashboardPlan;
  planHash: string;
  validation: FieldValidationResult;
  metadataApiAvailable: boolean;
  /**
   * True when a workbook with `plan.publishing.workbookName` already exists in the target
   * project. The UI uses this to ask the user whether to overwrite or rename BEFORE
   * approval (overwrite is part of the approval hash, so it must be decided up front).
   */
  nameConflict: boolean;
}

/** Does a workbook with this exact name already exist in the target project? */
async function workbookNameExists(session: Session, projectId: string, workbookName: string): Promise<boolean> {
  const wanted = workbookName.trim().toLowerCase();
  if (!wanted) return false;
  try {
    const workbooks = await TableauService.listWorkbooks(session);
    return workbooks.some((w) => w.projectId === projectId && (w.name ?? '').trim().toLowerCase() === wanted);
  } catch (err) {
    // A conflict check failure must never block planning — publishing will still surface a
    // real conflict (403130) if one exists.
    log.warn('Could not check for an existing workbook name; skipping conflict check', { reason: String(err) });
    return false;
  }
}

function fieldSummary(md: DatasourceMetadata): string {
  const list = (fs: { name: string; dataType: string }[]) =>
    fs.length ? fs.map((f) => `${f.name} (${f.dataType})`).join(', ') : '(none)';
  return [
    `Dimensions: ${list(md.dimensions)}`,
    `Measures: ${list(md.measures)}`,
    `Dates: ${list(md.dates)}`,
  ].join('\n');
}

/** Extract a JSON object from possibly fenced/verbose model text. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  // Strip ```json ... ``` fences if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  // Fall back to the outermost {...} span.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  const slice = start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(slice);
}

/**
 * Ask the tool-less planner for a DashboardPlan draft. Uses prompt-injected JSON
 * (robust across gateways that lack native structured-output support). If the
 * structured pass yields nothing usable, fall back to parsing JSON from the model's
 * raw text so a gateway quirk doesn't block planning.
 */
async function generatePlanDraft(prompt: string, sessionId: string): Promise<DashboardPlanDraft> {
  const requestContext = new RequestContext([['sessionId', sessionId]]);
  let structured: unknown;
  try {
    const result = await dashboardPlannerAgent.generate(prompt, {
      structuredOutput: { schema: DashboardPlanDraftSchema, jsonPromptInjection: 'system' },
      requestContext,
    });
    structured = (result as { object?: unknown }).object;
  } catch (err) {
    log.warn('Structured planning pass failed; will try text fallback', { reason: String(err) });
  }

  if (structured !== undefined && structured !== null) {
    const parsed = DashboardPlanDraftSchema.safeParse(structured);
    if (parsed.success) return parsed.data;
    log.warn('Structured plan did not match schema; trying text fallback', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).slice(0, 8),
    });
  }

  // Fallback: plain-text generation + manual JSON parsing.
  const jsonPrompt = `${prompt}\n\nReturn ONLY the DashboardPlan draft as a single JSON object. No prose, no markdown fences.`;
  const textResult = await dashboardPlannerAgent.generate(jsonPrompt, { requestContext });
  const text = (textResult as { text?: string }).text ?? '';
  let obj: unknown;
  try {
    obj = extractJsonObject(text);
  } catch {
    throw new AppError('TABLEAU_API', 'The AI planner did not return a usable dashboard plan.', {
      hint: 'Try rephrasing your request or simplifying it, then generate the plan again.',
    });
  }
  const parsed = DashboardPlanDraftSchema.safeParse(obj);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'The AI plan did not match the required structure.', {
      hint: 'Try rephrasing the request. If it persists, simplify the number of charts/filters.',
      details: { issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).slice(0, 8) },
    });
  }
  return parsed.data;
}

export async function generateDashboardPlan(
  session: Session,
  request: string,
  workbookName?: string,
): Promise<PlanningResult> {
  const lock = session.flow.datasourceLock;
  const project = session.flow.projectContext;
  if (!TableauService.isConnected(session)) throw new AppError('AUTH_REQUIRED', 'Connect to Tableau Cloud first.');
  if (!lock) throw new AppError('DATASOURCE_LOCKED', 'Select and lock a datasource before planning.');
  if (!project) throw new AppError('VALIDATION', 'Select a target project before planning.');

  return withSpan('planning.generate', { dashboardRequestChars: request.length }, async () => {
    const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
    if (!metadata.metadataApiAvailable || metadata.fields.length === 0) {
      throw new AppError('TABLEAU_API', 'Could not read datasource fields from the Tableau Metadata API.', {
        hint: 'Ensure the Metadata API is enabled for the site and the datasource has been indexed.',
        details: metadata.unavailableReason ? { reason: metadata.unavailableReason } : undefined,
      });
    }

    const prompt = [
      `Create a dashboard plan for the locked datasource "${lock.datasourceName}".`,
      ``,
      `Use ONLY these real fields (never invent fields):`,
      fieldSummary(metadata),
      ``,
      `User request:`,
      request,
      ``,
      `Produce a DashboardPlan draft that yields a polished, best-practice dashboard:`,
      `- Choose the most communicative chartType per worksheet from: bar, horizontal_bar,`,
      `  stacked_bar, side_by_side_bar, line, dual_line, area, scatter, pie, donut, text_table,`,
      `  highlight_table, heatmap, treemap, map, symbol_map, filled_map, histogram, bubble,`,
      `  kpi, dual_axis, bar_line_combo, detail (row-level table: all fields discrete on Rows).`,
      `- Order fields meaningfully: primary category/date first in "dimensions" (a secondary`,
      `  dimension for color/series second); primary measure first in "measures" (for scatter/`,
      `  bubble the first measure is X, the second is Y; dual_* charts need exactly two measures`,
      `  plus a date dimension).`,
      `- Give monetary measures a currency numberFormat and rates a percentage numberFormat;`,
      `  use scale thousands/millions for large values. Turn on formatting.showLabels for bars/KPIs.`,
      `- Add interactive "filters" (showAsControl true, scope all_worksheets) for the 2-4`,
      `  dimensions a user would slice by; leave values empty unless the user named specific ones.`,
      `- For a TOP/BOTTOM N chart: add a worksheet filter with operator "top_n" on the ranked`,
      `  dimension plus a topN object { n, byMeasure, measureAggregation, direction }, ALWAYS add`,
      `  an integer "Top N" parameter, and set topN.nParameter to that parameter's name so N is`,
      `  adjustable. Prefer a sorted horizontal_bar for the ranking.`,
      `- KPI ROWS ARE PURE: KPI cards (kind "kpi") share the top row and NEVER mix with non-KPI`,
      `  charts; charts go in rows below. Place the key chart large. Set a concise layout.title and`,
      `  give every worksheet a non-overlapping layout item. Choose layout.size "automatic",`,
      `  "fixed" (width x height) or "range" (min/max) — default "fixed" 1200x800 if unspecified.`,
      `  Only add calculated fields whose referenced fields all exist. The workbook/dashboard`,
      `  name should reflect the request.`,
      `- MULTIPLE DASHBOARDS: if the user asks for SEVERAL separate dashboards, populate the`,
      `  "dashboards" array (one named board per dashboard, each with its own "items" that`,
      `  reference worksheets by name); otherwise leave "dashboards" empty and use "layout".`,
    ].join('\n');

    const draft = await generatePlanDraft(prompt, session.id);

    // Inject the approved publishing target server-side (target-project guard authority).
    const plan: DashboardPlan = {
      ...draft,
      datasource: {
        datasourceId: lock.datasourceId,
        datasourceName: lock.datasourceName,
        siteId: lock.siteId,
        contentUrl: lock.contentUrl,
      },
      publishing: {
        siteId: project.siteId,
        projectId: project.projectId,
        projectName: project.projectName,
        // Prefer the user-provided workbook name; fall back to the AI's dashboard name.
        workbookName: workbookName?.trim() || draft.dashboardName,
        overwrite: false,
        showTabs: true,
        mode: 'new_workbook',
      },
    };

    const validation = validatePlanFields(plan, metadata);
    session.flow.plan = plan;
    // Any prior approval is invalidated when a new plan is generated.
    session.flow.approvedPlanHash = undefined;
    const planHash = hashPlan(plan);
    const nameConflict = await workbookNameExists(session, plan.publishing.projectId, plan.publishing.workbookName);
    recordEvent('plan.generated', {
      dashboard: plan.dashboardName,
      worksheets: plan.worksheets.length,
      valid: validation.valid,
    });
    return { plan, planHash, validation, metadataApiAvailable: metadata.metadataApiAvailable, nameConflict };
  });
}

/**
 * Revise the EXISTING plan from a natural-language instruction (the "chat with the plan"
 * feature). Feeds the current plan + instruction to the same planner (structured output),
 * preserves the approved publishing target + datasource, re-validates fields, and
 * invalidates any prior approval so the user re-approves the revised plan.
 */
export async function reviseDashboardPlan(session: Session, instruction: string): Promise<PlanningResult> {
  const current = session.flow.plan;
  if (!current) throw new AppError('APPROVAL_REQUIRED', 'Generate a plan before revising it.');
  const lock = session.flow.datasourceLock;
  if (!lock) throw new AppError('DATASOURCE_LOCKED', 'Select and lock a datasource before revising.');
  const ask = instruction.trim();
  if (!ask) throw new AppError('VALIDATION', 'Describe the change you want to make.');

  return withSpan('planning.revise', { instructionChars: ask.length }, async () => {
    const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
    if (!metadata.metadataApiAvailable || metadata.fields.length === 0) {
      throw new AppError('TABLEAU_API', 'Could not read datasource fields from the Tableau Metadata API.', {
        hint: 'Ensure the Metadata API is enabled for the site and the datasource has been indexed.',
      });
    }

    // Strip the server-owned publishing target from the JSON the model sees; it is
    // re-injected below so the model can never retarget the project/workbook.
    const { publishing: _pub, ...draftLike } = current;
    const prompt = [
      `Revise the EXISTING dashboard plan below according to the user's instruction.`,
      `Keep everything the user did NOT ask to change (do not rename or drop unrelated`,
      `worksheets, dashboards, filters, or formatting).`,
      ``,
      `Use ONLY these real fields (never invent fields):`,
      fieldSummary(metadata),
      ``,
      `CURRENT PLAN (JSON):`,
      JSON.stringify(draftLike),
      ``,
      `USER INSTRUCTION:`,
      ask,
      ``,
      `Return the COMPLETE revised DashboardPlan draft (same schema), applying the same`,
      `best-practice rules (pure KPI rows, readable number formats, valid field references).`,
      `If the user asks for SEPARATE/MULTIPLE dashboards, populate "dashboards" (one named`,
      `board per dashboard, each with its own "items"); otherwise keep using "layout".`,
    ].join('\n');

    const draft = await generatePlanDraft(prompt, session.id);
    const plan: DashboardPlan = {
      ...draft,
      datasource: {
        datasourceId: lock.datasourceId,
        datasourceName: lock.datasourceName,
        siteId: lock.siteId,
        contentUrl: lock.contentUrl,
      },
      publishing: current.publishing,
    };

    const validation = validatePlanFields(plan, metadata);
    session.flow.plan = plan;
    session.flow.approvedPlanHash = undefined; // revision invalidates prior approval
    const planHash = hashPlan(plan);
    const nameConflict = await workbookNameExists(session, plan.publishing.projectId, plan.publishing.workbookName);
    recordEvent('plan.revised', {
      dashboard: plan.dashboardName,
      worksheets: plan.worksheets.length,
      dashboards: plan.dashboards.length,
      valid: validation.valid,
    });
    return { plan, planHash, validation, metadataApiAvailable: metadata.metadataApiAvailable, nameConflict };
  });
}

/**
 * Update the publishing options (workbook name and/or overwrite) on the plan already in
 * session — WITHOUT re-running the LLM. Because `publishing` is part of the approval hash,
 * any change here invalidates a prior approval, so the user must re-approve. Returns the
 * refreshed plan, its new hash, and whether the (possibly renamed) workbook still conflicts.
 */
export async function setPublishingOptions(
  session: Session,
  opts: { workbookName?: string; overwrite?: boolean },
): Promise<PlanningResult> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'Generate a plan before changing publishing options.');

  const nextName = opts.workbookName?.trim();
  if (nextName !== undefined && nextName.length === 0) {
    throw new AppError('VALIDATION', 'Workbook name cannot be empty.');
  }
  if (nextName) plan.publishing.workbookName = nextName;
  if (typeof opts.overwrite === 'boolean') plan.publishing.overwrite = opts.overwrite;

  // Changing the publishing target invalidates any prior approval.
  session.flow.approvedPlanHash = undefined;
  session.flow.plan = plan;

  const lock = session.flow.datasourceLock;
  const metadata = lock ? await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName) : undefined;
  const validation = metadata
    ? validatePlanFields(plan, metadata)
    : ({ valid: true, issues: [] } as unknown as FieldValidationResult);
  const planHash = hashPlan(plan);
  const nameConflict = await workbookNameExists(session, plan.publishing.projectId, plan.publishing.workbookName);
  recordEvent('plan.publishing_updated', {
    dashboard: plan.dashboardName,
    workbookName: plan.publishing.workbookName,
    overwrite: plan.publishing.overwrite,
  });
  return {
    plan,
    planHash,
    validation,
    metadataApiAvailable: metadata?.metadataApiAvailable ?? true,
    nameConflict,
  };
}

/**
 * Set the dashboard SIZE on the plan already in session — WITHOUT re-running the LLM.
 * The app asks the user to choose Automatic / Fixed / Range before publishing; this
 * applies that choice. Because the layout is part of the approval hash, changing size
 * invalidates any prior approval (the user must re-approve). Returns the refreshed plan.
 */
export async function setDashboardSize(
  session: Session,
  opts: {
    size: 'automatic' | 'fixed' | 'range';
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
  },
): Promise<PlanningResult> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'Generate a plan before choosing a dashboard size.');

  // Apply the size to the primary layout AND every board, so a multi-dashboard workbook
  // actually picks up the chosen size (the generator reads each board's own size).
  const applySize = (t: {
    size?: 'automatic' | 'fixed' | 'range';
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
  }): void => {
    t.size = opts.size;
    if (opts.width != null) t.width = opts.width;
    if (opts.height != null) t.height = opts.height;
    if (opts.minWidth != null) t.minWidth = opts.minWidth;
    if (opts.minHeight != null) t.minHeight = opts.minHeight;
    if (opts.maxWidth != null) t.maxWidth = opts.maxWidth;
    if (opts.maxHeight != null) t.maxHeight = opts.maxHeight;
  };
  applySize(plan.layout);
  for (const board of plan.dashboards) applySize(board);

  // Changing the layout invalidates any prior approval.
  session.flow.approvedPlanHash = undefined;
  session.flow.plan = plan;

  const lock = session.flow.datasourceLock;
  const metadata = lock ? await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName) : undefined;
  const validation = metadata
    ? validatePlanFields(plan, metadata)
    : ({ valid: true, issues: [] } as unknown as FieldValidationResult);
  const planHash = hashPlan(plan);
  const nameConflict = await workbookNameExists(session, plan.publishing.projectId, plan.publishing.workbookName);
  recordEvent('plan.size_updated', { dashboard: plan.dashboardName, size: plan.layout.size });
  return {
    plan,
    planHash,
    validation,
    metadataApiAvailable: metadata?.metadataApiAvailable ?? true,
    nameConflict,
  };
}

/**
 * Re-validate + re-hash the mutated plan in session, invalidating any prior approval.
 * Shared by the "edit the plan without re-running the LLM" setters below.
 */
async function refreshPlan(
  session: Session,
  eventName: string,
  eventFields: Record<string, unknown>,
  preloadedMetadata?: DatasourceMetadata,
): Promise<PlanningResult> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'There is no plan to update.');
  session.flow.approvedPlanHash = undefined;
  session.flow.plan = plan;

  const lock = session.flow.datasourceLock;
  const metadata =
    preloadedMetadata ??
    (lock ? await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName) : undefined);
  const validation = metadata
    ? validatePlanFields(plan, metadata)
    : ({ valid: true, issues: [] } as unknown as FieldValidationResult);
  const planHash = hashPlan(plan);
  const nameConflict = await workbookNameExists(session, plan.publishing.projectId, plan.publishing.workbookName);
  recordEvent(eventName, { dashboard: plan.dashboardName, ...eventFields });
  return {
    plan,
    planHash,
    validation,
    metadataApiAvailable: metadata?.metadataApiAvailable ?? true,
    nameConflict,
  };
}

/**
 * Set dashboard APPEARANCE (background/container colors + title font) on the plan in
 * session — no LLM re-run. Invalidates any prior approval.
 */
export async function setDashboardAppearance(
  session: Session,
  opts: { backgroundColor?: string; containerBackground?: string; titleFormat?: TextFormat | null },
): Promise<PlanningResult> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'Generate a plan before changing appearance.');
  const applyAppearance = (t: {
    backgroundColor?: string;
    containerBackground?: string;
    titleFormat?: TextFormat;
  }): void => {
    if (opts.backgroundColor !== undefined) t.backgroundColor = opts.backgroundColor || undefined;
    if (opts.containerBackground !== undefined) t.containerBackground = opts.containerBackground || undefined;
    if (opts.titleFormat !== undefined) t.titleFormat = opts.titleFormat ?? undefined;
  };
  applyAppearance(plan.layout);
  for (const board of plan.dashboards) applyAppearance(board);
  return refreshPlan(session, 'plan.appearance_updated', {});
}

/**
 * Toggle/configure the dashboard "use as filter" ACTION on the plan in session — no LLM
 * re-run. When disabled, a `type:'none'` sentinel is stored so the generator does not
 * auto-add the default interactivity. Invalidates any prior approval.
 */
export async function setDashboardActions(
  session: Session,
  opts: { enabled: boolean; runOn?: 'select' | 'hover' | 'menu'; caption?: string; excludeSheets?: string[] },
): Promise<PlanningResult> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'Generate a plan before changing interactivity.');
  plan.actions = opts.enabled
    ? [
        {
          type: 'filter',
          runOn: opts.runOn ?? 'select',
          caption: opts.caption?.trim() || undefined,
          excludeSheets: opts.excludeSheets ?? [],
        },
      ]
    : [{ type: 'none', runOn: 'select', excludeSheets: [] }];
  return refreshPlan(session, 'plan.actions_updated', { enabled: opts.enabled });
}

/**
 * Update per-worksheet FORMATTING (reference lines, grand totals, color palette, value
 * labels, title font) on the plan in session — no LLM re-run. Field references are
 * validated against live metadata. Invalidates any prior approval.
 */
export async function updateWorksheetFormatting(
  session: Session,
  opts: {
    name: string;
    referenceLines?: ReferenceLineSpec[];
    grandTotals?: GrandTotals | null;
    colorMap?: ColorMapSpec | null;
    showLabels?: boolean;
    titleFormat?: TextFormat | null;
    colorField?: string | null;
    fit?: FitMode | null;
  },
): Promise<PlanningResult> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'Generate a plan before formatting a worksheet.');
  const ws = plan.worksheets.find((w) => w.name === opts.name);
  if (!ws) throw new AppError('NOT_FOUND', `Worksheet "${opts.name}" is not in the current plan.`);

  const lock = session.flow.datasourceLock;
  const metadata = lock ? await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName) : undefined;
  const fieldNames = new Set((metadata?.fields ?? []).map((f) => f.name));
  const checkField = (field: string, where: string): void => {
    if (metadata && fieldNames.size > 0 && !fieldNames.has(field)) {
      throw new AppError('VALIDATION', `${where} references "${field}", which is not a field in the datasource.`);
    }
  };

  if (opts.referenceLines !== undefined) {
    for (const rl of opts.referenceLines) checkField(rl.field, 'A reference line');
    ws.referenceLines = opts.referenceLines.length > 0 ? opts.referenceLines : undefined;
  }
  if (opts.grandTotals !== undefined) ws.grandTotals = opts.grandTotals ?? undefined;
  if (opts.colorMap !== undefined) {
    if (opts.colorMap) checkField(opts.colorMap.field, 'A color palette');
    ws.colorMap = opts.colorMap ?? undefined;
  }
  if (opts.showLabels !== undefined) ws.formatting = { ...ws.formatting, showLabels: opts.showLabels };
  if (opts.titleFormat !== undefined) ws.formatting = { ...ws.formatting, titleFormat: opts.titleFormat ?? undefined };
  if (opts.colorField !== undefined) {
    const cf = opts.colorField?.trim();
    if (cf) checkField(cf, 'A color field');
    ws.formatting = { ...ws.formatting, colorField: cf || undefined };
  }
  if (opts.fit !== undefined) ws.formatting = { ...ws.formatting, fit: opts.fit ?? undefined };

  return refreshPlan(session, 'plan.worksheet_formatting_updated', { worksheet: ws.name }, metadata);
}

/** Record human approval for the exact plan currently in session state. */
export async function approvePlan(
  session: Session,
  expectedHash: string,
): Promise<{ approved: boolean; planHash: string }> {
  const plan = session.flow.plan;
  if (!plan) throw new AppError('APPROVAL_REQUIRED', 'There is no plan to approve.');
  const currentHash = hashPlan(plan);
  if (currentHash !== expectedHash) {
    throw new AppError('APPROVAL_REQUIRED', 'The plan changed since it was shown. Please review the latest plan.');
  }

  // HARD GATE at approval: every field the plan uses must exist in the live datasource.
  // Blocking here (not just at execute) means the user cannot approve a plan that
  // references a hallucinated field — such charts/KPIs publish but render BLANK. Only
  // enforced when metadata is actually available (otherwise the field set is unknown).
  const lock = session.flow.datasourceLock;
  if (lock) {
    const metadata = await TableauService.getMetadata(session, lock.datasourceId, lock.datasourceName);
    if (metadata.fields.length > 0) {
      const validation = validatePlanFields(plan, metadata);
      if (!validation.valid) {
        const bad = validation.errors
          .slice(0, 10)
          .map((e) => `"${e.field}" (${e.location})`)
          .join(', ');
        throw new AppError(
          'VALIDATION',
          `The plan references fields that do not exist in the datasource: ${bad}. Revise the plan so it only uses available fields before approving.`,
          { details: { errors: validation.errors } },
        );
      }
    }
  }

  session.flow.approvedPlanHash = currentHash;
  recordEvent('plan.approved', { dashboard: plan.dashboardName });
  return { approved: true, planHash: currentHash };
}
