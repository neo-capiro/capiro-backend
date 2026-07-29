import { describe, expect, jest, test } from '@jest/globals';
import {
  backfill,
  extractPromotedFields,
  needsUpdate,
  parseArgs,
  type BackfillPrisma,
} from './backfill-sam-opportunity-fields.js';

describe('CLI parsing', () => {
  test('dry run is the default and the batch is bounded', () => {
    expect(parseArgs([])).toEqual({ commit: false, batch: 1000 });
    expect(parseArgs(['n', 'x', '--batch', '999999']).batch).toBe(5000);
    expect(parseArgs(['n', 'x', '--batch=2000']).batch).toBe(2000);
    expect(parseArgs(['n', 'x', '--batch', 'nonsense']).batch).toBe(1000);
    expect(parseArgs(['n', 'x', '--commit']).commit).toBe(true);
  });
});

describe('extractPromotedFields reads SAM.gov field names, from what we already hold', () => {
  test('all four fields are promoted out of the raw payload', () => {
    expect(
      extractPromotedFields({
        baseType: 'Presolicitation',
        subTier: 'DEPT OF THE ARMY',
        typeOfSetAside: 'SBA',
        typeOfSetAsideDescription: 'Total Small Business Set-Aside (FAR 19.5)',
      }),
    ).toEqual({
      baseType: 'Presolicitation',
      subAgency: 'DEPT OF THE ARMY',
      setAsideCode: 'SBA',
      setAside: 'Total Small Business Set-Aside (FAR 19.5)',
    });
  });

  test('absent fields are null, and a blank string is null too', () => {
    expect(extractPromotedFields({ baseType: '   ', subTier: null })).toEqual({
      baseType: null,
      subAgency: null,
      setAside: null,
      setAsideCode: null,
    });
  });

  test('a non-object raw payload yields all nulls rather than throwing', () => {
    for (const v of [null, undefined, 'string', 42, []]) {
      expect(extractPromotedFields(v)).toEqual({
        baseType: null,
        subAgency: null,
        setAside: null,
        setAsideCode: null,
      });
    }
  });

  test('values are clipped to the migration column widths', () => {
    // A vendor string longer than the column is a write failure, and one long
    // value must not fail a whole batch.
    const long = 'X'.repeat(200);
    const out = extractPromotedFields({ baseType: long, typeOfSetAside: long });
    expect(out.baseType).toHaveLength(64);
    expect(out.setAsideCode).toHaveLength(16);
  });
});

describe('needsUpdate keeps the backfill idempotent', () => {
  const same = {
    baseType: 'Presolicitation',
    subAgency: 'ARMY',
    setAside: 'SB',
    setAsideCode: 'SBA',
  };
  test('identical values need no write', () => {
    expect(needsUpdate(same, { ...same })).toBe(false);
  });
  test('any single difference needs a write', () => {
    expect(needsUpdate(same, { ...same, baseType: 'Solicitation' })).toBe(true);
    expect(needsUpdate(same, { ...same, subAgency: null })).toBe(true);
    expect(needsUpdate(same, { ...same, setAside: null })).toBe(true);
    expect(needsUpdate(same, { ...same, setAsideCode: 'SBP' })).toBe(true);
  });
});

function makeFake(rows: Array<Record<string, unknown>>) {
  const updates: unknown[] = [];
  const findArgs: unknown[] = [];
  let served = false;
  const prisma: BackfillPrisma = {
    samOpportunity: {
      findMany: jest.fn(async (args: unknown) => {
        findArgs.push(args);
        if (served) return [] as never;
        served = true;
        return rows as never;
      }),
      update: jest.fn(async (args: unknown) => {
        updates.push(args);
        return {};
      }),
    },
  };
  return { prisma, updates, findArgs };
}

describe('backfill', () => {
  const withRaw = {
    id: 'a',
    baseType: null,
    subAgency: null,
    setAside: null,
    setAsideCode: null,
    raw: { baseType: 'Presolicitation', subTier: 'ARMY' },
  };

  test('a dry run reports what WOULD change and writes nothing', async () => {
    const { prisma, updates } = makeFake([withRaw]);
    const r = await backfill(prisma, { commit: false, batch: 10 });
    expect(r.scanned).toBe(1);
    expect(r.updated).toBe(1);
    expect(updates).toHaveLength(0);
  });

  test('--commit writes exactly the promoted fields', async () => {
    const { prisma, updates } = makeFake([withRaw]);
    await backfill(prisma, { commit: true, batch: 10 });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      where: { id: 'a' },
      data: { baseType: 'Presolicitation', subAgency: 'ARMY', setAside: null, setAsideCode: null },
    });
  });

  test('a second pass over already-promoted rows updates nothing', async () => {
    const { prisma, updates } = makeFake([
      { ...withRaw, baseType: 'Presolicitation', subAgency: 'ARMY' },
    ]);
    const r = await backfill(prisma, { commit: true, batch: 10 });
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(1);
    expect(updates).toHaveLength(0);
  });

  test('a row whose raw carried none of the four fields is counted, not silently skipped', async () => {
    const { prisma } = makeFake([{ ...withRaw, raw: { noticeId: 'x' } }]);
    const r = await backfill(prisma, { commit: true, batch: 10 });
    expect(r.noSourceFields).toBe(1);
    expect(r.updated).toBe(0);
  });

  test('one bad row does not abort the batch', async () => {
    const { prisma } = makeFake([withRaw, { ...withRaw, id: 'b' }]);
    let calls = 0;
    (prisma.samOpportunity.update as jest.Mock).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('value too long');
      return {};
    });
    const r = await backfill(prisma, { commit: true, batch: 10 });
    expect(r.errors).toBe(1);
    expect(r.scanned).toBe(2);
  });

  test('paging is keyset-based, not offset-based', async () => {
    // An offset scan re-reads every earlier row on each page; on the largest table
    // in the database that is the difference between minutes and hours.
    const { prisma, findArgs } = makeFake([withRaw, { ...withRaw, id: 'b' }]);
    await backfill(prisma, { commit: false, batch: 2 });
    const second = findArgs[1] as Record<string, unknown>;
    expect(second.cursor).toEqual({ id: 'b' });
    expect(second.skip).toBe(1);
  });
});
