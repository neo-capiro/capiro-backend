import { describe, expect, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  parseRepairFacilityDistrictArgs,
  repairFacilityDistrict,
  repairFacilityDistrictCodes,
} from './repair-facility-district-codes.js';

const asPrisma = (fake: unknown): PrismaClient => fake as PrismaClient;
const TENANT = '00000000-0000-0000-0000-000000000001';

describe('argument parsing', () => {
  test('dry run is the default', () => {
    expect(parseRepairFacilityDistrictArgs(['node', 's'])).toEqual({
      commit: false,
      tenantId: null,
      clientId: null,
    });
  });

  test('--commit, --tenant and --client are honoured in both spellings', () => {
    expect(
      parseRepairFacilityDistrictArgs(['node', 's', '--commit', '--tenant', 't1', '--client', 'c1']),
    ).toEqual({ commit: true, tenantId: 't1', clientId: 'c1' });
    expect(parseRepairFacilityDistrictArgs(['node', 's', '--tenant=t2'])).toEqual({
      commit: false,
      tenantId: 't2',
      clientId: null,
    });
  });
});

describe('repairFacilityDistrict', () => {
  test('pads a bare single digit — the actual production defect', () => {
    // The 7 rows found on 2026-07-30, verbatim.
    expect(repairFacilityDistrict('FL', '1')).toBe('01');
    expect(repairFacilityDistrict('GA', '5')).toBe('05');
    expect(repairFacilityDistrict('NC', '8')).toBe('08');
    expect(repairFacilityDistrict('TN', '3')).toBe('03');
    expect(repairFacilityDistrict('WA', '7')).toBe('07');
    expect(repairFacilityDistrict('WA', '8')).toBe('08');
  });

  test('an already-canonical value needs no repair — the pass is idempotent', () => {
    // Returning null rather than an identical string is what stops a second run
    // rewriting every row and churning updated_at.
    for (const code of ['01', '07', '16', '43', '00']) {
      expect(repairFacilityDistrict('TX', code)).toBeNull();
    }
  });

  test('a single-seat jurisdiction stores 00, not 01', () => {
    // At-largeness is derived from apportionment, never read off the value: a sole
    // House seat is reported as "1" by some sources and must key as '00' to join
    // against a geocoded at-large facility.
    expect(repairFacilityDistrict('WY', '1')).toBe('00');
    expect(repairFacilityDistrict('VT', '1')).toBe('00');
    expect(repairFacilityDistrict('DE', '01')).toBe('00');
    // …and an at-large row already stored as '00' is left alone.
    expect(repairFacilityDistrict('WY', '00')).toBeNull();
  });

  test('sentinels pass through untouched', () => {
    // '98' is written by the geocoder for non-voting delegates — observed in
    // production. Repairing it into a numbered district would invent a seat.
    for (const sentinel of ['90', '98', 'ZZ']) {
      expect(repairFacilityDistrict('DC', sentinel)).toBeNull();
    }
  });

  test('null, empty and whitespace are left alone', () => {
    expect(repairFacilityDistrict('TX', null)).toBeNull();
    expect(repairFacilityDistrict('TX', '')).toBeNull();
    expect(repairFacilityDistrict('TX', '   ')).toBeNull();
  });

  test('an unknown state still pads — the format is state-independent', () => {
    // Only the at-large collapse needs apportionment; padding does not.
    expect(repairFacilityDistrict(null, '7')).toBe('07');
    expect(repairFacilityDistrict('XX', '7')).toBe('07');
  });

  test('the output is a FIXED POINT — repairing it again is a no-op', () => {
    for (const [state, code] of [
      ['FL', '1'],
      ['WY', '1'],
      ['WA', '7'],
      ['DE', '01'],
    ] as const) {
      const once = repairFacilityDistrict(state, code);
      expect(once).not.toBeNull();
      expect(repairFacilityDistrict(state, once!)).toBeNull();
    }
  });

  test('no repair ever changes which SEAT the district refers to', () => {
    // The safety property that makes this runnable without re-attribution review:
    // the numeric value is preserved (or collapsed to at-large for a state that
    // has exactly one seat, which is the same seat).
    for (const code of ['1', '2', '9', '07', '16']) {
      const next = repairFacilityDistrict('TX', code);
      if (next == null) continue;
      expect(Number(next)).toBe(Number(code));
    }
  });
});

// ── Integration over a fake client ──────────────────────────────────────────

function repairFake(rows: Array<{ id: string; name: string; state: string | null; congressionalDistrict: string | null }>) {
  const updates: any[] = [];
  const audits: any[] = [];
  const pages: Array<{ cursor: string | null; where: any }> = [];
  const fake: Record<string, any> = {};
  fake.$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(fake);
  fake.$executeRawUnsafe = async () => 0;
  const store = rows.map((r) => ({ tenantId: TENANT, ...r }));
  fake.clientFacility = {
    findMany: async (args: any) => {
      const cursor: string | null = args?.where?.id?.gt ?? null;
      pages.push({ cursor, where: args?.where });
      return store
        .filter((r) => (cursor ? r.id > cursor : true))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args?.take ?? store.length);
    },
    update: async (args: any) => {
      updates.push(args);
      const row = store.find((r) => r.id === args.where.id);
      if (row) row.congressionalDistrict = args.data.congressionalDistrict;
      return row;
    },
  };
  fake.auditLog = {
    create: async (args: any) => {
      audits.push(args);
      return args;
    },
  };
  return { fake, updates, audits, pages, store };
}

const PROD_ROWS = [
  { id: 'f1', name: 'Peter Prince Field (Airport)', state: 'FL', congressionalDistrict: '1' },
  { id: 'f2', name: 'PS ATL', state: 'GA', congressionalDistrict: '5' },
  { id: 'f3', name: 'Headquarters - Locust', state: 'NC', congressionalDistrict: '8' },
  { id: 'f4', name: 'R-50 Microreactor Production Facility', state: 'TN', congressionalDistrict: '3' },
  { id: 'f5', name: 'Overland Labs', state: 'WA', congressionalDistrict: '7' },
  { id: 'f6', name: 'Overland Factory', state: 'WA', congressionalDistrict: '7' },
  { id: 'f7', name: 'Overland Proving Grounds', state: 'WA', congressionalDistrict: '8' },
];

describe('repairFacilityDistrictCodes', () => {
  test('a dry run writes nothing but reports every change', async () => {
    const { fake, updates, audits } = repairFake(PROD_ROWS);
    const result = await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: false,
    });
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(result.repaired).toBe(7);
    expect(result.changes).toHaveLength(7);
    expect(result.changes[0]).toMatchObject({ state: 'FL', from: '1', to: '01' });
  });

  test('--commit writes the padded value and an audit row in one transaction', async () => {
    const { fake, updates, audits, store } = repairFake(PROD_ROWS);
    await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(updates).toHaveLength(7);
    expect(store.map((r) => r.congressionalDistrict)).toEqual([
      '01', '05', '08', '03', '07', '07', '08',
    ]);
    expect(audits).toHaveLength(7);
    expect(audits[0].data.action).toBe('client_facility.congressional_district.normalized');
    expect(audits[0].data.entityType).toBe('client_facilities');
    expect(audits[0].data.before.congressionalDistrict).toBe('1');
    expect(audits[0].data.after.congressionalDistrict).toBe('01');
  });

  test('districtSource is NOT touched', async () => {
    // This is a format correction, not a re-determination. Rewriting a 'geocoded'
    // row to 'user' would destroy the provenance district-nexus.verification.ts
    // uses to decide how much to trust the district.
    const { fake, updates } = repairFake(PROD_ROWS);
    await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    for (const u of updates) expect(Object.keys(u.data)).toEqual(['congressionalDistrict']);
  });

  test('already-canonical rows are skipped, not rewritten', async () => {
    const { fake, updates } = repairFake([
      { id: 'g1', name: 'Padded', state: 'TX', congressionalDistrict: '16' },
      { id: 'g2', name: 'At large', state: 'WY', congressionalDistrict: '00' },
      { id: 'g3', name: 'Delegate', state: 'DC', congressionalDistrict: '98' },
    ]);
    const result = await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(updates).toHaveLength(0);
    expect(result.skipped).toBe(3);
    expect(result.repaired).toBe(0);
  });

  test('running it twice is idempotent', async () => {
    const { fake, updates } = repairFake(PROD_ROWS);
    const first = await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    const second = await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(first.repaired).toBe(7);
    expect(second.repaired).toBe(0);
    expect(second.skipped).toBe(7);
    expect(updates).toHaveLength(7);
  });

  test('every row is visited by keyset pagination, not one capped window', async () => {
    const many = Array.from({ length: 1_200 }, (_, i) => ({
      id: `f-${String(i).padStart(5, '0')}`,
      name: `Facility ${i}`,
      state: 'TX',
      congressionalDistrict: '7',
    }));
    const { fake, pages } = repairFake(many);
    const result = await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(result.evaluated).toBe(1_200);
    expect(result.repaired).toBe(1_200);
    expect(pages).toHaveLength(3);
    expect(pages[0]!.cursor).toBeNull();
    expect(pages[1]!.cursor).toBe('f-00499');
  });

  test('--tenant and --client narrow the walk', async () => {
    const { fake, pages } = repairFake(PROD_ROWS);
    await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: TENANT,
      clientId: 'c1',
      commit: false,
    });
    expect(pages[0]!.where.tenantId).toBe(TENANT);
    expect(pages[0]!.where.clientId).toBe('c1');
  });

  test('one failing row does not abort the pass', async () => {
    const { fake } = repairFake(PROD_ROWS);
    const real = fake.clientFacility.update;
    fake.clientFacility.update = async (args: any) => {
      if (args.where.id === 'f1') throw new Error('row locked');
      return real(args);
    };
    const result = await repairFacilityDistrictCodes(asPrisma(fake), {
      tenantId: null,
      clientId: null,
      commit: true,
    });
    expect(result.errors).toBe(1);
    expect(result.updated).toBe(6);
  });
});
