import { OfficeRecommenderService } from './office-recommender.service.js';
import { DirectoryContactMapper } from '../directory/directory-contact-mapper.js';

function mappedHouse(state: string, districtNo: number | null) {
  const contacts = new DirectoryContactMapper().buildContacts(
    [
      {
        member: { member_id: 901, profile: { first_name: 'Synthetic', last_name: 'Member' } },
        member_offices: [
          { status: 'in office', office_type_id: 'HM', state_id: state, district_no: districtNo },
        ],
      },
    ],
    [],
  );
  if (!contacts[0]) throw new Error('Expected the canonical mapper to emit a contact');
  return contacts[0];
}

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
  if (!row) throw new Error('Expected the committee-backed recommendation');
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

describe.each(['AK', 'DE', 'ND', 'SD', 'VT', 'WY', 'DC', 'PR', 'GU', 'VI', 'AS', 'MP'])(
  'canonical single-seat directory member %s',
  (state) => {
    test.each([0, null, 1])(
      'mapper district %s matches a valid at-large facility',
      async (districtNo) => {
        const contact = mappedHouse(state, districtNo);
        expect(contact.district).toBe(districtNo === 1 ? `${state}-1` : state);
        const rows = await recommendations([{ state, congressionalDistrict: '00' }], [contact]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ tags: ['district'], score: 0.48 });
      },
    );
  },
);

test('canonical at-large House member retains committee and district credit', async () => {
  const contact = mappedHouse('AK', null);
  contact.committees = ['Armed Services'];
  const rows = await recommendations(
    [{ state: 'AK', congressionalDistrict: '00' }],
    [contact],
    true,
  );
  expect(rows[0]).toMatchObject({ tags: ['committee', 'district'], billCount: 3 });
  expect(rows[0]?.score).toBeCloseTo(0.88);
});

test.each(['0', '00', '1', '01', 'AK-1'])(
  'valid facility single-seat form %s shares canonical at-large key',
  async (district) => {
    const rows = await recommendations(
      [{ state: 'AK', congressionalDistrict: district }],
      [mappedHouse('AK', 1)],
    );
    expect(rows[0]?.tags).toEqual(['district']);
  },
);

test.each([null, '', 'AK', 'unknown', '2', '98', 'DE-0'])(
  'at-large context does not invent a resolved facility for %s',
  async (district) => {
    expect(
      await recommendations(
        [{ state: 'AK', congressionalDistrict: district }],
        [mappedHouse('AK', null)],
      ),
    ).toEqual([]);
  },
);

test.each([null, '', 'unknown', '2', '98', 'DE-0'])(
  'at-large context does not repair a malformed/absent member district %s',
  async (district) => {
    expect(
      await recommendations(
        [{ state: 'AK', congressionalDistrict: '00' }],
        [member('house', 'House', 'AK', district)],
      ),
    ).toEqual([]);
  },
);

test('canonical multi-seat mapper missing district is not guessed from state', async () => {
  expect(
    await recommendations(
      [{ state: 'TX', congressionalDistrict: '05' }],
      [mappedHouse('TX', null)],
    ),
  ).toEqual([]);
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
