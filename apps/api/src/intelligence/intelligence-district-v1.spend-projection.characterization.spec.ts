import {
  census,
  clientId,
  deferred,
  harness,
  installHooks,
  linkedSpend,
  member,
  ownUei,
  spendRow,
  tenantId,
} from '../../test/fixtures/intelligence-district.js';

installHooks();

describe('District spend global catalog scope', () => {
  test('finishes Census lookup before querying current representatives with full state names', async () => {
    const demographics = deferred<unknown[]>();
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [
          spendRow(),
          spendRow({ pop_state: 'CT', pop_district: '03' }),
          spendRow({ pop_state: 'VA', pop_district: '03' }),
          spendRow({ pop_state: 'TX', pop_district: null }),
        ],
        census: demographics.promise,
      },
    });
    const pending = h.service.getDistrictNexusSpend(clientId, tenantId);
    await h.started('census');
    expect(h.callsOf('members')).toEqual([]);
    demographics.resolve([]);
    await pending;
    expect(h.callsOf('members')[0]).toEqual({
      operation: 'members',
      scope: 'global',
      args: [
        {
          where: {
            isCurrent: true,
            chamber: { in: ['house', 'senate'] },
            state: { in: ['Virginia', 'Connecticut'] },
          },
          select: {
            bioguideId: true,
            fullName: true,
            party: true,
            state: true,
            district: true,
            chamber: true,
          },
        },
      ],
    });
    expect(h.events).toEqual([
      'withTenant',
      'tenant:begin',
      'mappings',
      'client',
      'tenant:commit',
      'spend',
      'census',
      'members',
    ]);
  });
});

describe('District spend global catalog scope', () => {
  test('normalizes but does not deduplicate Census keys and queries newest Congress without a cap', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow(), spendRow({ pop_district: '2' }), spendRow({ pop_district: '98' })],
      },
    });
    await linkedSpend(h);
    const query = h.callsOf('census')[0]!.query!;
    expect(query.kind).toBe('tagged');
    expect(query.values).toEqual([['VA-2', 'VA-2', 'VA-AL']]);
    expect(query.sql).toContain('SELECT DISTINCT ON (state, district)');
    expect(query.sql).toContain('ORDER BY state, district, congress DESC');
    expect(query.sql).not.toMatch(/LIMIT|data_year DESC/);
  });
  test('omits Census and roster reads when every award lacks a resolved state or district', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow({ pop_state: null }), spendRow({ pop_district: null })],
      },
    });
    expect(await linkedSpend(h)).toMatchObject({
      totalAwards: 6,
      totalAmount: 2400,
      unmappedAmount: 2400,
      districtCount: 0,
      districts: [],
    });
    expect(h.callsOf('census')).toEqual([]);
    expect(h.callsOf('members')).toEqual([]);
  });
});

describe('District spend aggregation and demographics', () => {
  test('coerces counts and amounts, retains negatives and zeroes, and includes unmapped totals', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [
          spendRow({ award_count: 9007199254740993n, total_amount: '12.5' }),
          spendRow({ pop_district: '03', award_count: 1n, total_amount: -2 }),
          spendRow({ pop_state: '', award_count: 2n, total_amount: null }),
          spendRow({ pop_district: '', award_count: 4n, total_amount: 7 }),
        ],
      },
    });
    const value = await linkedSpend(h);
    expect(value.totalAwards).toBe(Number(9007199254740993n) + 1 + 2 + 4);
    expect(value.totalAmount).toBe(17.5);
    expect(value.unmappedAmount).toBe(7);
    expect(value.districts.map((row) => [row.district, row.totalAmount])).toEqual([
      ['VA-2', 12.5],
      ['VA-3', -2],
    ]);
  });
  test('sorts mapped rows by dollars, preserves tie order and leaves source rows unchanged', async () => {
    const rows = [
      spendRow({ pop_district: '03', total_amount: 100 }),
      spendRow({ total_amount: 500 }),
      spendRow({ pop_district: '04', total_amount: 100 }),
    ];
    const h = harness({ rows: { client: { uei: ownUei }, spend: rows } });
    expect((await linkedSpend(h)).districts.map((row) => row.district)).toEqual([
      'VA-2',
      'VA-3',
      'VA-4',
    ]);
    expect(rows.map((row) => row.pop_district)).toEqual(['03', '02', '04']);
  });
  test('keeps separate raw award groups even when their normalized district keys collide', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow(), spendRow({ pop_district: '2', total_amount: 500 })],
      },
    });
    const value = await linkedSpend(h);
    expect(value.districtCount).toBe(2);
    expect(value.districts.map((row) => [row.district, row.totalAmount])).toEqual([
      ['VA-2', 1200],
      ['VA-2', 500],
    ]);
  });
  test('preserves the Census projection and uses null when a district has no Census row', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow(), spendRow({ pop_district: '03' })],
        census: [
          census({
            total_population: null,
            median_household_income: 0,
            labor_force_size: null,
            unemployment_rate: null,
            percent_veteran: 0,
          }),
        ],
      },
    });
    const value = await linkedSpend(h);
    expect(value.districts[0]!.demographics).toEqual({
      totalPopulation: null,
      medianHouseholdIncome: 0,
      laborForceSize: null,
      unemploymentRate: null,
      percentVeteran: 0,
      dataYear: 2024,
    });
    expect(value.districts[1]!.demographics).toBeNull();
  });
});

describe('District spend raw catalog values', () => {
  test('returns every mapped row without imposing a display limit', async () => {
    const rows = Array.from({ length: 35 }, (_, index) =>
      spendRow({ pop_district: String(index + 1), total_amount: index }),
    );
    const h = harness({ rows: { client: { uei: ownUei }, spend: rows } });
    const value = await linkedSpend(h);
    expect(value.districtCount).toBe(35);
    expect(value.districts).toHaveLength(35);
    expect(value.districts[0]!.district).toBe('VA-35');
    expect(value.districts[34]!.district).toBe('VA-1');
    expect(h.callsOf('spend')[0]!.query!.sql).not.toContain('LIMIT');
  });
  test.each([NaN, Infinity])(
    'retains nonfinite amount %p rather than adding a clamp',
    async (amount) => {
      const h = harness({
        rows: { client: { uei: ownUei }, spend: [spendRow({ total_amount: amount })] },
      });
      const value = await linkedSpend(h);
      expect(value.totalAmount).toBe(amount);
      expect(value.districts[0]!.totalAmount).toBe(amount);
    },
  );
  test('retains unknown state spend but skips an unfiltered member query', async () => {
    const h = harness({
      rows: { client: { uei: ownUei }, spend: [spendRow({ pop_state: 'XX' })] },
    });
    expect((await linkedSpend(h)).districts[0]).toMatchObject({
      district: 'XX-2',
      demographics: null,
      representatives: { house: null, senate: [] },
    });
    expect(h.callsOf('census')[0]!.query!.values).toEqual([['XX-2']]);
    expect(h.callsOf('members')).toEqual([]);
  });
  test('looks up a lowercase state name but retains raw state keys for member matching', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow({ pop_state: 'va' })],
        members: [member()],
      },
    });
    expect((await linkedSpend(h)).districts[0]).toMatchObject({
      district: 'va-2',
      representatives: { house: null, senate: [] },
    });
    expect(h.callsOf('members')[0]!.args[0]).toMatchObject({
      where: { state: { in: ['Virginia'] } },
    });
  });
});

describe('District spend House and Senate identity', () => {
  test('selects the first matching House member and preserves original member objects and Senate order', async () => {
    const house = member();
    const secondHouse = member({ bioguideId: 'H000002' });
    const senate = [
      member({ bioguideId: 'S000002', chamber: 'senate', district: null }),
      member({ bioguideId: 'S000001', chamber: 'senate', district: null }),
      member({ bioguideId: 'S000003', chamber: 'senate', district: null }),
    ];
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow()],
        members: [secondHouse, ...senate, house],
      },
    });
    const reps = (await linkedSpend(h)).districts[0]!.representatives;
    expect(reps.house).toBe(secondHouse);
    expect(reps.senate).toEqual(senate);
    expect(reps.senate[0]).toBe(senate[0]);
    expect(h.callsOf('members')).toHaveLength(1);
  });
  test('matches padded numbered codes and ignores unknown state or chamber roster rows', async () => {
    const house = member({ district: 3 });
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow({ pop_district: ' 003 ' })],
        members: [member({ state: 'Unknown' }), member({ chamber: 'joint', district: 3 }), house],
      },
    });
    const district = (await linkedSpend(h)).districts[0]!;
    expect(district.district).toBe('VA-3');
    expect(district.representatives.house).toBe(house);
    expect(district.representatives.senate).toEqual([]);
  });
});

describe('District spend at-large and unknown seats', () => {
  test.each([
    { raw: '00', memberDistrict: null },
    { raw: 'AL', memberDistrict: 0 },
  ])(
    'matches actual at-large $raw to a null-or-zero House district',
    async ({ raw, memberDistrict }) => {
      const house = member({ state: 'Wyoming', district: memberDistrict });
      const h = harness({
        rows: {
          client: { uei: ownUei },
          spend: [spendRow({ pop_state: 'WY', pop_district: raw })],
          census: [census({ state: 'WY', district: 'AL' })],
          members: [house],
        },
      });
      const district = (await linkedSpend(h)).districts[0]!;
      expect(district.district).toBe('WY-AL');
      expect(district.demographics).not.toBeNull();
      expect(district.representatives.house).toBe(house);
    },
  );
  test.each(['98', '90', 'ZZ', 'nonnumeric', ' '])(
    'keeps Senate independent when raw seat %p cannot identify House',
    async (raw) => {
      const house = member({ district: null });
      const senator = member({ bioguideId: 'S000001', chamber: 'senate', district: null });
      const h = harness({
        rows: {
          client: { uei: ownUei },
          spend: [spendRow({ pop_district: raw })],
          census: [census({ district: 'AL' })],
          members: [house, senator],
        },
      });
      const district = (await linkedSpend(h)).districts[0]!;
      expect(district).toMatchObject({ district: 'VA-AL', demographics: { dataYear: 2024 } });
      expect(district.representatives.house).toBeNull();
      expect(district.representatives.senate).toEqual([senator]);
      expect(district.representatives.senate[0]).toBe(senator);
    },
  );
  test('does not guess a numbered House member for an at-large code', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        spend: [spendRow({ pop_state: 'WY', pop_district: '00' })],
        members: [member({ state: 'Wyoming', district: 1 })],
      },
    });
    expect((await linkedSpend(h)).districts[0]!.representatives.house).toBeNull();
  });
});

describe('District spend fatal catalog reads', () => {
  test.each(['census', 'members'])(
    'propagates the %s error after committing tenant reads',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({
        rows: { client: { uei: ownUei }, spend: [spendRow()] },
        errors: { [operation]: error },
      });
      await expect(h.service.getDistrictNexusSpend(clientId, tenantId)).rejects.toBe(error);
      expect(h.transactions[0]!.outcome).toBe('commit');
      expect(h.callsOf('spend')).toHaveLength(1);
      expect(h.callsOf('members')).toHaveLength(operation === 'members' ? 1 : 0);
    },
  );
});
