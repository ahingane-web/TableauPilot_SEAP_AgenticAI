import { describe, it, expect } from 'vitest';
import { hashPlan, assertDatasourceLock, assertProjectMatch, assertApproved } from '../../src/validation/guards.js';
import { AppError } from '../../src/utils/errors.js';
import { makePlan, SITE_ID, DS_ID, PROJECT_ID } from '../fixtures/plan.js';
import type { DatasourceLock, TableauProjectContext } from '../../src/schemas/common.js';

const lock: DatasourceLock = {
  datasourceId: DS_ID,
  datasourceName: 'Superstore',
  siteId: SITE_ID,
  contentUrl: 'superstore',
  lockedAt: new Date().toISOString(),
};

const project: TableauProjectContext = { siteId: SITE_ID, projectId: PROJECT_ID, projectName: 'Sales' };

describe('hashPlan', () => {
  it('is stable for identical plans and changes when the plan changes', () => {
    const a = hashPlan(makePlan());
    const b = hashPlan(makePlan());
    expect(a).toBe(b);
    const mutated = makePlan();
    mutated.dashboardName = 'Different';
    expect(hashPlan(mutated)).not.toBe(a);
  });
});

describe('assertDatasourceLock', () => {
  it('passes when the plan references the locked datasource', () => {
    expect(() => assertDatasourceLock(lock, makePlan())).not.toThrow();
  });
  it('throws when no lock exists', () => {
    expect(() => assertDatasourceLock(undefined, makePlan())).toThrow(AppError);
  });
  it('throws when the plan references a different datasource', () => {
    const plan = makePlan();
    plan.datasource.datasourceId = 'other-ds';
    expect(() => assertDatasourceLock(lock, plan)).toThrow(/different datasource/i);
  });
});

describe('assertProjectMatch', () => {
  it('passes when publishing matches the approved project', () => {
    expect(() => assertProjectMatch(project, makePlan())).not.toThrow();
  });
  it('throws when the target project differs', () => {
    const plan = makePlan();
    plan.publishing.projectId = 'elsewhere';
    expect(() => assertProjectMatch(project, plan)).toThrow(AppError);
  });
});

describe('assertApproved', () => {
  it('passes only when the approved hash matches the current plan', () => {
    const plan = makePlan();
    expect(() => assertApproved(hashPlan(plan), plan)).not.toThrow();
  });
  it('throws when there is no approval', () => {
    expect(() => assertApproved(undefined, makePlan())).toThrow(/approval/i);
  });
  it('throws when the plan changed after approval', () => {
    const approved = hashPlan(makePlan());
    const changed = makePlan();
    changed.worksheets[0]!.chartType = 'line';
    expect(() => assertApproved(approved, changed)).toThrow(/changed/i);
  });
});
