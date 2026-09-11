import { describe, it, expect } from 'vitest';
import { validateCalcRefs } from '../../src/tools/calcInspectionTools.js';
import { selfCorrectRefs, type CalcDesignResult } from '../../src/tools/calculationTool.js';
import type { DatasourceField } from '../../src/tableau/types.js';

const fields: DatasourceField[] = [
  { name: 'Sales', role: 'measure', dataType: 'REAL', isDate: false },
  { name: 'Profit', role: 'measure', dataType: 'REAL', isDate: false },
  { name: 'Category', role: 'dimension', dataType: 'STRING', isDate: false },
  { name: 'Order Date', role: 'dimension', dataType: 'DATE', isDate: true },
];

describe('validateCalcRefs', () => {
  it('accepts a calc that references only real fields', () => {
    const problems = validateCalcRefs(
      [{ name: 'Profit Ratio', formula: 'SUM([Profit]) / SUM([Sales])', referencedFields: [], role: 'measure' }],
      fields,
    );
    expect(problems).toHaveLength(0);
  });

  it('flags an unknown field with suggestions', () => {
    const problems = validateCalcRefs(
      [{ name: 'Rev Ratio', formula: 'SUM([Revenue]) / SUM([Sale])', referencedFields: [], role: 'measure' }],
      fields,
    );
    expect(problems).toHaveLength(1);
    const refs = problems[0]!.unknownRefs.map((u) => u.ref).sort();
    expect(refs).toEqual(['Revenue', 'Sale']);
    // 'Sale' is close to 'Sales'.
    expect(problems[0]!.unknownRefs.find((u) => u.ref === 'Sale')!.suggestions).toContain('Sales');
  });

  it('allows helper-calc refs, a known parameter, and the [Parameters] qualifier', () => {
    const problems = validateCalcRefs(
      [
        { name: 'Big Sales', formula: 'IF [Sales] > 1000 THEN [Sales] ELSE 0 END', referencedFields: [], role: 'measure' },
        { name: 'Adj', formula: 'SUM([Big Sales]) * [Parameters].[Factor]', referencedFields: [], role: 'measure' },
      ],
      fields,
      ['Factor'], // a known parameter name
    );
    expect(problems).toHaveLength(0);
  });
});

describe('selfCorrectRefs', () => {
  const clean: CalcDesignResult = {
    calculations: [{ name: 'Profit Ratio', formula: 'SUM([Profit])/SUM([Sales])', referencedFields: [], role: 'measure' }],
    rationale: ['ratio'],
    configNotes: [],
  };

  it('returns the initial result unchanged when references are valid', async () => {
    let called = false;
    const out = await selfCorrectRefs(clean, fields, async () => {
      called = true;
      return clean;
    });
    expect(called).toBe(false);
    expect(out).toBe(clean);
  });

  it('re-prompts exactly once when a reference is unknown', async () => {
    const bad: CalcDesignResult = {
      calculations: [{ name: 'Bad', formula: 'SUM([Revenue])', referencedFields: [], role: 'measure' }],
      rationale: ['x'],
      configNotes: [],
    };
    let calls = 0;
    let feedbackSeen = '';
    const out = await selfCorrectRefs(bad, fields, async (feedback) => {
      calls += 1;
      feedbackSeen = feedback;
      return clean;
    });
    expect(calls).toBe(1);
    expect(feedbackSeen).toContain('[Revenue]');
    expect(out).toBe(clean);
  });

  it('does not re-prompt when a clarification is requested', async () => {
    const ambiguous: CalcDesignResult = { clarificationNeeded: 'which period?', calculations: [], rationale: [], configNotes: [] };
    let called = false;
    const out = await selfCorrectRefs(ambiguous, fields, async () => {
      called = true;
      return clean;
    });
    expect(called).toBe(false);
    expect(out).toBe(ambiguous);
  });
});
