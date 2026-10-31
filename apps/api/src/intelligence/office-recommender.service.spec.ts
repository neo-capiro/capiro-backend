import { OfficeRecommenderService } from './office-recommender.service.js';

const member = (
  id: string,
  chamber: 'House' | 'Senate',
  state: string,
  district: string | null,
  committees: string[] = [],
) => ({
  id,
  fullName: id,
  chamber,
  state,
  district,
  committees,
  focusAreas: [],
  leadershipPositions: [],
  party: null,
});
async function recommendations(
  facilities: Array<{ state: string; congressionalDistrict: string | null }>,
  members: any[],
  committee = false,
) {
  const tx = { clientFacility: { findMany: jest.fn(async () => facilities) } };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, work: any) => work(tx)),
    $queryRaw: jest.fn(async () =>
      committee ? [{ committee_name: 'Armed Services', bill_count: 3 }] : [],
    ),
  };
  const service = new OfficeRecommenderService(
    prisma as never,
    { getAllContacts: async () => members } as never,
  );
  return service.recommend({
    clientId: 'synthetic-client',
    tenantId: 'synthetic-tenant',
    trackedBillIds: committee ? ['synthetic-bill'] : [],
    trackedBills: [],
    issueCodes: [],
  });
}

test('known facility district selects its House member and state Senators, not other same-state districts', async () => {
  const rows = await recommendations(
    [{ state: 'TX', congressionalDistrict: '05' }],
    [
      member('own-house', 'House', 'TX', 'TX-5'),
      member('other-house', 'House', 'TX', 'TX-6'),
      member('own-senate', 'Senate', 'TX', null),
      member('other-state', 'Senate', 'CA', null),
    ],
  );
  expect(rows.map((row) => row.memberId).sort()).toEqual(['own-house', 'own-senate']);
  expect(rows.every((row) => row.tags.includes('district') && row.score === 0.48)).toBe(true);
});
test('unknown facility district proves state nexus only for Senate', async () => {
  const rows = await recommendations(
    [{ state: 'TX', congressionalDistrict: null }],
    [member('house', 'House', 'TX', '5'), member('senate', 'Senate', 'TX', null)],
  );
  expect(rows.map((row) => row.memberId)).toEqual(['senate']);
});
test('a different House district retains committee evidence without district points', async () => {
  const [row] = await recommendations(
    [{ state: 'TX', congressionalDistrict: '5' }],
    [member('house', 'House', 'TX', '6', ['Armed Services'])],
    true,
  );
  expect(row.tags).toEqual(['committee']);
  expect(row.score).toBeCloseTo(0.7);
  expect(row.billCount).toBe(3);
});
test('bare zero and zero-padded at-large districts resolve to the same district', async () => {
  const rows = await recommendations(
    [{ state: 'AK', congressionalDistrict: '00' }],
    [member('at-large', 'House', 'AK', 'AK-0')],
  );
  expect(rows[0]?.tags).toEqual(['district']);
});
test.each(['unknown', '5.1', '-1', ''])(
  'malformed district %s is not constituent evidence',
  async (district) => {
    const rows = await recommendations(
      [{ state: 'TX', congressionalDistrict: district }],
      [member('house', 'House', 'TX', district)],
    );
    expect(rows).toEqual([]);
  },
);
test('a prefixed district for a different state is not silently reattributed', async () => {
  const rows = await recommendations(
    [{ state: 'TX', congressionalDistrict: '5' }],
    [member('house', 'House', 'TX', 'CA-5')],
  );
  expect(rows).toEqual([]);
});
