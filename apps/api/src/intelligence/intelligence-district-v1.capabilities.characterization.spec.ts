import {
  capability,
  census,
  clientId,
  harness,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-district.js';

installHooks();

describe('District capability input scope', () => {
  test('reads the exact capability projection in the requested tenant before the catalog', async () => {
    const h = harness({ rows: { capabilities: [capability()], census: [census()] } });
    await h.service.getDistrictNexus(clientId, tenantId);
    expect(h.callsOf('capabilities')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 1,
      args: [
        {
          where: { clientId },
          select: {
            id: true,
            name: true,
            sector: true,
            districtNexus: true,
            existingContracts: true,
          },
        },
      ],
    });
    expect(h.events).toEqual([
      'withTenant',
      'tenant:begin',
      'capabilities',
      'tenant:commit',
      'census',
    ]);
    expect(h.callsOf('census')[0]).toMatchObject({ scope: 'global' });
    expect(h.callsOf('census')[0]!.transaction).toBeUndefined();
  });
  test('returns the exact empty capability envelope without catalog reads', async () => {
    const h = harness();
    expect(await h.service.getDistrictNexus(clientId, tenantId)).toEqual({ capabilities: [] });
    expect(h.callsOf('census')).toEqual([]);
  });
  test('retains unmatched and null free text without inferring jobs', async () => {
    const h = harness({
      rows: {
        capabilities: [
          capability({ districtNexus: null, existingContracts: '100 jobs' }),
          capability({ id: 'cap-two', districtNexus: 'Virginia second district' }),
        ],
      },
    });
    const result = await h.service.getDistrictNexus(clientId, tenantId);
    expect(result.capabilities).toEqual([
      {
        capabilityId: 'cap-one',
        capabilityName: 'Research',
        capabilitySector: 'DEFENSE',
        districtNexus: null,
        districts: [],
        talkingPoints: [],
        totalSupportedJobs: null,
      },
      {
        capabilityId: 'cap-two',
        capabilityName: 'Research',
        capabilitySector: 'DEFENSE',
        districtNexus: 'Virginia second district',
        districts: [],
        talkingPoints: [],
        totalSupportedJobs: null,
      },
    ]);
    expect(h.callsOf('census')).toEqual([]);
  });
});

describe('District capability geography vocabulary', () => {
  test.each([
    { name: 'case and leading zeros', text: 'va-002 TX 03 fl/al', keys: ['VA-2', 'TX-3', 'FL-AL'] },
    {
      name: 'optional CD marker and separators',
      text: 'CA-CD-52; VA CD2; TX/CD 3',
      keys: ['CA-52', 'VA-2', 'TX-3'],
    },
    {
      name: 'per-capability canonical deduplication',
      text: 'VA-02, TX-3, VA 2, VA-CD-002',
      keys: ['VA-2', 'TX-3'],
    },
    {
      name: 'three digit and arbitrary state vocabulary',
      text: 'ZZ-999 VA-000',
      keys: ['ZZ-999', 'VA-0'],
    },
    {
      name: 'word boundary and unsupported spellings',
      text: 'XVA-2 VA_2 VA:2 TX-1234',
      keys: [],
    },
    { name: 'slash CD marker is parsed as an arbitrary state', text: 'VA/CD/2', keys: ['CD-2'] },
    { name: 'line breaks as district separators', text: 'VA\n02 CA\t52', keys: ['VA-2', 'CA-52'] },
  ])('preserves $name', async ({ text, keys }) => {
    const h = harness({ rows: { capabilities: [capability({ districtNexus: text })] } });
    await h.service.getDistrictNexus(clientId, tenantId);
    expect(h.callsOf('census').map((call) => call.query!.values)).toEqual(
      keys.length ? [[keys]] : [],
    );
  });
  test('keeps repeated keys across capabilities and uses latest-Congress DISTINCT catalog SQL', async () => {
    const h = harness({
      rows: {
        capabilities: [capability(), capability({ id: 'cap-two', districtNexus: 'VA-2 CA-52' })],
      },
    });
    await h.service.getDistrictNexus(clientId, tenantId);
    const query = h.callsOf('census')[0]!.query!;
    expect(query.values).toEqual([['VA-2', 'VA-2', 'CA-52']]);
    expect(query.sql).toContain('SELECT DISTINCT ON (state, district)');
    expect(query.sql).toContain("WHERE state || '-' || district = ANY(?::text[])");
    expect(query.sql).toContain('ORDER BY state, district, congress DESC');
    expect(query.sql).not.toMatch(/LIMIT|data_year DESC/);
  });
});

describe('District capability Census projection', () => {
  test('follows parsed key order and drops missing catalog keys', async () => {
    const h = harness({
      rows: {
        capabilities: [capability({ districtNexus: 'CA-52 TX-3 VA-2' })],
        census: [census(), census({ id: 'ca', state: 'CA', district: '52' })],
      },
    });
    const result = await h.service.getDistrictNexus(clientId, tenantId);
    expect(result.capabilities[0]!.districts.map((row) => row.id)).toEqual(['ca', 'census-va-2']);
    expect(result.capabilities[0]!.talkingPoints.map((row) => row.district)).toEqual([
      'CA-52',
      'VA-2',
    ]);
  });
  test('preserves scalar fields and industry/evidence array references', async () => {
    const industries = [{ name: 'Research', share: 0.5 }];
    const row = census({
      top_industries: industries,
      total_population: null,
      median_household_income: 0,
      unemployment_rate: null,
    });
    const h = harness({ rows: { capabilities: [capability()], census: [row] } });
    const value = (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!;
    expect(value.districts[0]).toEqual({
      id: 'census-va-2',
      congress: 119,
      state: 'VA',
      district: '2',
      totalPopulation: null,
      medianHouseholdIncome: 0,
      laborForceSize: 400000,
      unemploymentRate: null,
      percentVeteran: 0.09,
      topIndustries: industries,
      dataYear: 2024,
    });
    expect(value.districts[0]!.topIndustries).toBe(industries);
    expect(value.talkingPoints[0]!.evidence.topIndustries).toBe(industries);
    expect(row.top_industries).toBe(industries);
  });
  test.each([null, { name: 'Research' }, 'Research'])(
    'defaults non-array industries %p to an empty array',
    async (topIndustries) => {
      const h = harness({
        rows: { capabilities: [capability()], census: [census({ top_industries: topIndustries })] },
      });
      expect(
        (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!.districts[0]!
          .topIndustries,
      ).toEqual([]);
    },
  );
  test.each([0, null])(
    'uses N/A for falsy labor force %p without explicit jobs',
    async (laborForce) => {
      const h = harness({
        rows: { capabilities: [capability()], census: [census({ labor_force_size: laborForce })] },
      });
      const value = (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!;
      expect(value.talkingPoints[0]!.headline).toBe(
        'Research has district nexus in VA-2 with labor force N/A.',
      );
      expect(value.totalSupportedJobs).toBeNull();
    },
  );
  test('renders positive labor force with its original locale formatting', async () => {
    const h = harness({ rows: { capabilities: [capability()], census: [census()] } });
    expect(
      (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!.talkingPoints[0]!
        .headline,
    ).toBe('Research has district nexus in VA-2 with labor force 400,000.');
  });
});

describe('District capability job attribution', () => {
  test.each([
    {
      name: 'existing contract precedence',
      contracts: '200 jobs',
      nexus: 'VA-2 CA-52 900 workers',
      perDistrict: 100,
      total: 200,
    },
    {
      name: 'nullish precedence preserves zero',
      contracts: '0 jobs',
      nexus: 'VA-2 CA-52 900 workers',
      perDistrict: 1,
      total: 2,
    },
    {
      name: 'nearest integer allocation',
      contracts: '5 employees',
      nexus: 'VA-2 CA-52',
      perDistrict: 3,
      total: 6,
    },
    {
      name: 'comma separated worker count',
      contracts: '1,900 workers',
      nexus: 'VA-2 CA-52',
      perDistrict: 950,
      total: 1900,
    },
    {
      name: 'singular jobs vocabulary',
      contracts: '1 job',
      nexus: 'VA-2 CA-52',
      perDistrict: 1,
      total: 2,
    },
    {
      name: 'district free-text fallback',
      contracts: 'Award active',
      nexus: 'VA-2 CA-52 12 employees',
      perDistrict: 6,
      total: 12,
    },
    {
      name: 'nonfinite count fallback',
      contracts: `${'9'.repeat(400)} jobs`,
      nexus: 'VA-2 CA-52 12 jobs',
      perDistrict: 6,
      total: 12,
    },
    {
      name: 'decimal text keeps trailing digit match',
      contracts: '12.5 jobs',
      nexus: 'VA-2 CA-52',
      perDistrict: 3,
      total: 6,
    },
    {
      name: 'negative text keeps unsigned digit match',
      contracts: '-7 jobs',
      nexus: 'VA-2 CA-52',
      perDistrict: 4,
      total: 8,
    },
  ])('preserves $name', async ({ contracts, nexus, perDistrict, total }) => {
    const h = harness({
      rows: {
        capabilities: [capability({ existingContracts: contracts, districtNexus: nexus })],
        census: [census(), census({ state: 'CA', district: '52' })],
      },
    });
    const value = (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!;
    expect(value.totalSupportedJobs).toBe(total);
    expect(value.talkingPoints.map((point) => point.headline)).toEqual([
      `Research supports ~${perDistrict.toLocaleString()} jobs in VA-2.`,
      `Research supports ~${perDistrict.toLocaleString()} jobs in CA-52.`,
    ]);
  });
});

describe('District capability job attribution', () => {
  test('divides by resolved districts rather than mentioned keys', async () => {
    const h = harness({
      rows: {
        capabilities: [capability({ districtNexus: 'VA-2 TX-3', existingContracts: '100 jobs' })],
        census: [census()],
      },
    });
    const value = (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!;
    expect(value.totalSupportedJobs).toBe(100);
    expect(value.talkingPoints[0]!.headline).toBe('Research supports ~100 jobs in VA-2.');
  });
  test('returns zero supported jobs when keys exist but no Census district resolves', async () => {
    const h = harness({ rows: { capabilities: [capability({ existingContracts: '100 jobs' })] } });
    const value = (await h.service.getDistrictNexus(clientId, tenantId)).capabilities[0]!;
    expect(value).toMatchObject({ districts: [], talkingPoints: [], totalSupportedJobs: 0 });
  });
});

describe('District capability fatal reads', () => {
  test.each(['capabilities', 'census'])(
    'propagates %s failure without a fallback result',
    async (operation) => {
      const error = new Error(`${operation} unavailable`);
      const h = harness({ rows: { capabilities: [capability()] }, errors: { [operation]: error } });
      await expect(h.service.getDistrictNexus(clientId, tenantId)).rejects.toBe(error);
      expect(h.transactions[0]!.outcome).toBe(operation === 'capabilities' ? 'rollback' : 'commit');
    },
  );
});
