import { describe, it, expect } from 'vitest';
import { DashboardPlanSchema, DashboardPlanDraftSchema } from '../../src/schemas/dashboardPlan.js';
import { makePlan } from '../fixtures/plan.js';

describe('DashboardPlan schema', () => {
  it('accepts a valid plan', () => {
    const res = DashboardPlanSchema.safeParse(makePlan());
    expect(res.success).toBe(true);
  });

  it('applies defaults for optional collections and flags', () => {
    const parsed = DashboardPlanSchema.parse({
      dashboardName: 'D',
      datasource: { datasourceId: 'd', datasourceName: 'n', siteId: 's' },
      worksheets: [{ name: 'W', chartType: 'bar' }],
      layout: {},
      publishing: { siteId: 's', projectId: 'p', projectName: 'P', workbookName: 'D' },
    });
    expect(parsed.filters).toEqual([]);
    expect(parsed.calculatedFields).toEqual([]);
    expect(parsed.parameters).toEqual([]);
    expect(parsed.layout.columns).toBe(4);
    expect(parsed.publishing.overwrite).toBe(false);
    expect(parsed.worksheets[0]!.measures).toEqual([]);
  });

  it('rejects a plan with no worksheets', () => {
    const bad = { ...makePlan(), worksheets: [] };
    expect(DashboardPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown chart type', () => {
    const bad: any = makePlan();
    bad.worksheets[0].chartType = 'hologram';
    expect(DashboardPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('draft schema omits publishing (injected server-side)', () => {
    expect('publishing' in DashboardPlanDraftSchema.shape).toBe(false);
    const { publishing, ...draft } = makePlan();
    void publishing;
    expect(DashboardPlanDraftSchema.safeParse(draft).success).toBe(true);
  });
});
