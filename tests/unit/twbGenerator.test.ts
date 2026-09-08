import { describe, it, expect } from 'vitest';
import { generateTwb, escapeXml } from '../../src/tableau/authoring/twbGenerator.js';
import { makePlan, metadata } from '../fixtures/plan.js';

describe('escapeXml', () => {
  it('escapes XML metacharacters', () => {
    expect(escapeXml(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  });
});

describe('generateTwb', () => {
  const xml = generateTwb(makePlan(), metadata);

  it('produces a well-formed workbook root', () => {
    expect(xml.startsWith("<?xml version='1.0'")).toBe(true);
    expect(xml).toContain('<workbook version=');
    expect(xml).toContain('</workbook>');
  });

  it('references the locked published datasource via sqlproxy', () => {
    expect(xml).toContain("<connection class='sqlproxy'");
    expect(xml).toContain("dbname='superstore'");
  });

  it('renders every worksheet from the plan', () => {
    expect(xml).toContain("<worksheet name='Sales by Category'>");
    expect(xml).toContain("<worksheet name='Profit Ratio'>");
  });

  it('emits columns for referenced fields and the calculated field', () => {
    expect(xml).toContain("caption='Category'");
    expect(xml).toContain("caption='Sales'");
    expect(xml).toContain("caption='Profit Ratio'");
    expect(xml).toContain("<calculation class='tableau'");
  });

  it('renders the dashboard with its name and zones', () => {
    expect(xml).toContain("<dashboard name='Sales Overview'>");
    expect(xml).toContain('<zones>');
  });

  it('does not invent fields absent from the plan', () => {
    expect(xml).not.toContain("caption='Discount'");
  });

  it('escapes a datasource name containing special characters', () => {
    const plan = makePlan();
    plan.dashboardName = 'A & B';
    const out = generateTwb(plan, metadata);
    expect(out).toContain("name='A &amp; B'");
  });
});
