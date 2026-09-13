import { describe, it, expect } from 'vitest';
import { SalesforceBuildSchema } from '../../src/schemas/common.js';

const creds = { url: 'https://login.salesforce.com', username: 'u@e.com', password: 'pw' };
const base = { credentials: creds, projectId: 'proj-1', datasourceName: 'DS' };

describe('SalesforceBuildSchema', () => {
  it('accepts a single-object build with no relationships', () => {
    const res = SalesforceBuildSchema.safeParse({ ...base, tables: ['Account'], relationships: [] });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.relationships).toEqual([]);
  });

  it('defaults relationships to [] when omitted', () => {
    const res = SalesforceBuildSchema.safeParse({ ...base, tables: ['Account'] });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.relationships).toEqual([]);
  });

  it('rejects a single-object build that carries relationships', () => {
    const res = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Account'],
      relationships: [
        { leftObject: 'Account', leftField: 'Id', rightObject: 'Contact', rightField: 'AccountId' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('accepts a connected multi-object graph and defaults cardinality to many-to-many + joinType to left', () => {
    const res = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Opportunity', 'Account', 'Contact'],
      relationships: [
        { leftObject: 'Opportunity', leftField: 'AccountId', rightObject: 'Account', rightField: 'Id' },
        { leftObject: 'Account', leftField: 'Id', rightObject: 'Contact', rightField: 'AccountId' },
      ],
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.relationships[0]!.cardinality).toBe('many-to-many');
      expect(res.data.relationships[0]!.joinType).toBe('left');
    }
  });

  it('defaults mode to relationship when omitted, and accepts join', () => {
    const dflt = SalesforceBuildSchema.safeParse({ ...base, tables: ['Account'], relationships: [] });
    expect(dflt.success).toBe(true);
    if (dflt.success) expect(dflt.data.mode).toBe('relationship');

    const join = SalesforceBuildSchema.safeParse({
      ...base,
      mode: 'join',
      tables: ['Opportunity', 'Account'],
      relationships: [
        { leftObject: 'Opportunity', leftField: 'AccountId', rightObject: 'Account', rightField: 'Id', joinType: 'inner' },
      ],
    });
    expect(join.success).toBe(true);
    if (join.success) {
      expect(join.data.mode).toBe('join');
      expect(join.data.relationships[0]!.joinType).toBe('inner');
    }
  });

  it('rejects an invalid mode or joinType', () => {
    expect(SalesforceBuildSchema.safeParse({ ...base, mode: 'bogus', tables: ['Account'], relationships: [] }).success).toBe(
      false,
    );
    const badJoin = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Opportunity', 'Account'],
      relationships: [
        { leftObject: 'Opportunity', leftField: 'AccountId', rightObject: 'Account', rightField: 'Id', joinType: 'cross' },
      ],
    });
    expect(badJoin.success).toBe(false);
  });

  it('rejects too few relationships to connect all objects', () => {
    const res = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Opportunity', 'Account', 'Contact'],
      relationships: [
        { leftObject: 'Opportunity', leftField: 'AccountId', rightObject: 'Account', rightField: 'Id' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects a disconnected graph (isolated object)', () => {
    const res = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Opportunity', 'Account', 'Contact', 'Lead'],
      relationships: [
        { leftObject: 'Opportunity', leftField: 'AccountId', rightObject: 'Account', rightField: 'Id' },
        // Contact <-> Lead is a separate component; Account/Opportunity not linked to it.
        { leftObject: 'Contact', leftField: 'Id', rightObject: 'Lead', rightField: 'ConvertedContactId' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects a relationship that references an object not in tables', () => {
    const res = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Opportunity', 'Account'],
      relationships: [
        { leftObject: 'Opportunity', leftField: 'AccountId', rightObject: 'Contact', rightField: 'AccountId' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects duplicate objects', () => {
    const res = SalesforceBuildSchema.safeParse({
      ...base,
      tables: ['Account', 'Account'],
      relationships: [
        { leftObject: 'Account', leftField: 'Id', rightObject: 'Account', rightField: 'Id' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an invalid object identifier', () => {
    const res = SalesforceBuildSchema.safeParse({ ...base, tables: ['Account; DROP'], relationships: [] });
    expect(res.success).toBe(false);
  });
});
