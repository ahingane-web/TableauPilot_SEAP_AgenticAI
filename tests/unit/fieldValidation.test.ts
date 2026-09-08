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
});
