import { describe, it, expect } from 'vitest';
import { validatePlanFields, extractFormulaFields } from '../../src/validation/fieldValidation.js';
import { makePlan, metadata } from '../fixtures/plan.js';

describe('extractFormulaFields', () => {
  it('extracts bracketed field tokens', () => {
    expect(extractFormulaFields('SUM([Profit]) / SUM([Sales])')).toEqual(['Profit', 'Sales']);
    expect(extractFormulaFields('no fields here')).toEqual([]);
  });
});

describe('validatePlanFields', () => {
  it('passes for a plan whose fields all exist (incl. calc fields)', () => {
    const res = validatePlanFields(makePlan(), metadata);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.availableMeasures).toContain('Sales');
    expect(res.availableDimensions).toContain('Region');
    expect(res.availableDates).toContain('Order Date');
  });

  it('flags an unknown dimension and reports its location', () => {
    const plan = makePlan();
    plan.worksheets[0]!.dimensions = ['Nonexistent'];
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === 'Nonexistent' && e.location.includes('dimensions'))).toBe(true);
  });

  it('flags a calculated field referencing an unknown field', () => {
    const plan = makePlan();
    plan.calculatedFields = [
      { name: 'Bad', formula: 'SUM([Revenue])', referencedFields: ['Revenue'], role: 'measure' },
    ];
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === 'Revenue')).toBe(true);
  });

  it('allows a filter on a known field but rejects an unknown filter field', () => {
    const plan = makePlan();
    plan.filters = [{ field: 'Ghost', operator: 'equals', values: ['x'], scope: 'all_worksheets', showAsControl: true }];
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === 'Ghost' && e.location.startsWith('filters'))).toBe(true);
  });

  it('matches field names case-insensitively (Tableau treats names case-insensitively)', () => {
    const plan = makePlan();
    plan.worksheets[0]!.dimensions = ['category']; // lower-case vs metadata "Category"
    plan.worksheets[0]!.measures = [{ field: 'SALES', aggregation: 'sum' }];
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(true);
  });

  it("flags a Top-N ranking measure (topN.byMeasure) that doesn't exist", () => {
    const plan = makePlan();
    plan.worksheets[0]!.filters = [
      { field: 'Category', operator: 'top_n', values: [], scope: 'all_worksheets', showAsControl: false, topN: { n: 5, byMeasure: 'Revenue', measureAggregation: 'sum', direction: 'top' } },
    ];
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === 'Revenue' && e.location.includes('topN.byMeasure'))).toBe(true);
  });

  it('flags an unknown reference-line field, colorMap field, and colorField', () => {
    const plan = makePlan();
    plan.worksheets[0]!.referenceLines = [{ field: 'Ghost1', aggregation: 'avg', formula: 'average', scope: 'per-pane', labelType: 'automatic' }];
    plan.worksheets[0]!.colorMap = { field: 'Ghost2', colors: [{ value: 'x', color: '#000000' }] };
    plan.worksheets[0]!.formatting = { colorField: 'Ghost3' };
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === 'Ghost1' && e.location.includes('referenceLines'))).toBe(true);
    expect(res.errors.some((e) => e.field === 'Ghost2' && e.location.includes('colorMap'))).toBe(true);
    expect(res.errors.some((e) => e.field === 'Ghost3' && e.location.includes('colorField'))).toBe(true);
  });

  it('flags a dashboard item referencing a worksheet the plan does not define', () => {
    const plan = makePlan();
    plan.dashboards = [
      { ...plan.layout, name: 'Board A', items: [{ worksheet: 'Ghost Sheet', row: 0, col: 0, rowSpan: 1, colSpan: 1, kind: 'chart' }] },
    ];
    const res = validatePlanFields(plan, metadata);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === 'Ghost Sheet' && e.location.includes('dashboards'))).toBe(true);
  });
});
