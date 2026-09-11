import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { packageTwbx } from '../../src/tableau/authoring/twbxPackager.js';

describe('packageTwbx', () => {
  const twb = `<?xml version='1.0' encoding='utf-8' ?>\n<workbook version='18.1'></workbook>`;

  it('produces a ZIP containing the .twb at the archive root', () => {
    const twbx = packageTwbx(twb, 'Sales Analysis Dashboard');
    const entries = unzipSync(new Uint8Array(twbx));
    const names = Object.keys(entries);
    expect(names).toEqual(['Sales Analysis Dashboard.twb']);
    expect(strFromU8(entries['Sales Analysis Dashboard.twb']!)).toBe(twb);
  });

  it('has a valid ZIP local-file-header signature (PK\\x03\\x04)', () => {
    const twbx = packageTwbx(twb, 'wb');
    expect(twbx[0]).toBe(0x50); // P
    expect(twbx[1]).toBe(0x4b); // K
    expect(twbx[2]).toBe(0x03);
    expect(twbx[3]).toBe(0x04);
  });

  it('sanitizes unsafe characters in the entry name', () => {
    const twbx = packageTwbx(twb, 'a/b:c*?');
    const names = Object.keys(unzipSync(new Uint8Array(twbx)));
    expect(names[0]).toBe('a_b_c__.twb');
  });
});
