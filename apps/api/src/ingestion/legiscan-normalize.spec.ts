import {
  computeSessionKey,
  normalizeBillNumber,
  buildStateBillKey,
  normalizeLegiscanBill,
  normalizeLegiscanChamber,
  resolveCurrentCommittee,
  crosswalkLegiscanPerson,
} from './legiscan-normalize.js';
import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';
import type { PrismaClient } from '@prisma/client';

describe('computeSessionKey', () => {
  it('regular session -> plain year_start', () => {
    expect(computeSessionKey({ year_start: 2025, special: 0, session_id: 1 })).toBe('2025');
  });
  it('special session -> "<year_start>x<session_id>" (DD1 disambiguator)', () => {
    expect(computeSessionKey({ year_start: 2025, special: 1, session_id: 1987 })).toBe('2025x1987');
  });
});

describe('normalizeBillNumber', () => {
  it('lowercases and strips spaces/periods', () => {
    expect(normalizeBillNumber('HB 1234')).toBe('hb1234');
    expect(normalizeBillNumber('H.B. 1234')).toBe('hb1234');
    expect(normalizeBillNumber('HJR12A')).toBe('hjr12a');
  });
  it("collapses DC-style hyphenated numbers ('B26-0001' -> 'b260001')", () => {
    expect(normalizeBillNumber('B26-0001')).toBe('b260001');
    expect(normalizeBillNumber('PR 26-0001')).toBe('pr260001');
  });
});

describe('buildStateBillKey', () => {
  it('builds the DD1 canonical key', () => {
    expect(buildStateBillKey('TX', '2025', 'HB 1234')).toBe('tx-2025-hb1234');
  });
  it('handles a special-session key', () => {
    expect(buildStateBillKey('tx', '2025x1987', 'HB1234')).toBe('tx-2025x1987-hb1234');
  });
  it('rejects a malformed state code', () => {
    expect(buildStateBillKey('texas', '2025', 'HB1234')).toBeNull();
  });
  it('collapses a DC-style hyphenated bill number into a single valid key segment', () => {
    // Regression: the un-collapsed "dc-2025-b26-0001" failed the stateBillKey
    // validator (extra hyphen segment), so DC seeded 0 bills.
    expect(buildStateBillKey('DC', '2025', 'B26-0001')).toBe('dc-2025-b260001');
  });
});

function fixtureBill(overrides: Partial<LegiscanBill> = {}): LegiscanBill {
  return {
    bill_id: 1234567,
    change_hash: 'abc123',
    session: {
      session_id: 1,
      year_start: 2025,
      year_end: 2026,
      session_name: '2025 Regular Session',
      special: 0,
      prior: 0,
    },
    url: 'https://legiscan.com/TX/bill/HB1234/2025',
    state_link: 'https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB1234',
    // Real getBill / bulk-dataset shape: the number is in bill_number and
    // `number` is null (getMasterList is the only op that uses `number`). The
    // fixture mirrors reality so the suite exercises the bill_number path the
    // 2026-07-11 activation bug hit (reading `number` dropped every bill).
    bill_number: 'HB1234',
    number: null,
    bill_type: 'B',
    body: 'H',
    current_body: 'H',
    title: 'Relating to a study on state legislative data.',
    description: 'An act relating to a study.',
    status: 1,
    status_date: '2025-01-15',
    progress: [{ date: '2025-01-15', event: 1 }],
    history: [
      { date: '2025-01-15', action: 'Filed', chamber: 'H', importance: 0 },
      {
        date: '2025-01-20',
        action: 'Referred to Committee on State Affairs',
        chamber: 'H',
        importance: 1,
      },
    ],
    sponsors: [
      {
        people_id: 111,
        name: 'Rep. Jane Doe',
        party: 'D',
        role: 'Rep',
        sponsor_type_id: 1,
        sponsor_order: 1,
      },
      {
        people_id: 222,
        name: 'Rep. John Smith',
        party: 'R',
        role: 'Rep',
        sponsor_type_id: 2,
        sponsor_order: 2,
      },
    ],
    sasts: [{ type: 'Same As', type_id: 1, sast_bill_number: 'SB5678', sast_bill_id: 7654321 }],
    subjects: [{ subject_id: 1, subject_name: 'Government Operations' }],
    texts: [
      {
        doc_id: 999,
        date: '2025-01-15',
        type: 'Introduced',
        mime: 'application/pdf',
        state_link: 'https://example.com/hb1234.pdf',
      },
    ],
    votes: [],
    calendar: [{ type: 'hearing', date: '2025-02-01', time: '9:00 AM', location: 'Room E2.010' }],
    ...overrides,
  };
}

describe('normalizeLegiscanBill', () => {
  it('builds the DD1 key + fields from a realistic getBill payload', () => {
    const n = normalizeLegiscanBill(fixtureBill(), 'TX');
    expect(n).not.toBeNull();
    expect(n?.billKey).toBe('tx-2025-hb1234');
    expect(n?.state).toBe('TX');
    expect(n?.sessionKey).toBe('2025');
    expect(n?.billNumber).toBe('hb1234');
    expect(n?.title).toBe('Relating to a study on state legislative data.');
    expect(n?.legiscanBillId).toBe(1234567);
    expect(n?.legiscanChangeHash).toBe('abc123');
    expect(n?.legiscanStatus).toBe(1);
    expect(n?.sponsorCount).toBe(2);
    expect(n?.sponsorName).toBe('Rep. Jane Doe'); // primary sponsor wins
    expect(n?.actions).toHaveLength(2);
    expect(n?.actions[0]?.orderKey).toBe(0);
    expect(n?.actions[1]?.orderKey).toBe(1);
    expect(n?.latestActionText).toBe('Referred to Committee on State Affairs'); // last history entry
    expect(n?.links).toEqual([{ legiscanRelatedBillId: 7654321, linkType: 'same_as' }]);
    expect(n?.versions).toHaveLength(1);
    expect(n?.versions[0]?.legiscanDocId).toBe(999);
    expect(n?.calendarEvents).toHaveLength(1);
    expect(n?.calendarEvents[0]?.eventKey).toBe('tx-2025-hb1234:hearing:2025-02-01:Room E2.010');
  });

  it('reads bill_number (getBill/dataset shape) — regression for the 2026-07-11 0-bill backfill', () => {
    // getBill + bulk-dataset put the number in bill_number with `number` null.
    // Reading `number` alone produced an invalid key → null → every bill dropped.
    const n = normalizeLegiscanBill(fixtureBill({ bill_number: 'SB99', number: null }), 'CA');
    expect(n?.billKey).toBe('ca-2025-sb99');
    expect(n?.identifier).toBe('SB99');
    expect(n?.billNumber).toBe('sb99');
  });

  it('falls back to number when bill_number is absent (getMasterList shape)', () => {
    const n = normalizeLegiscanBill(fixtureBill({ bill_number: null, number: 'HR5' }), 'NY');
    expect(n?.billKey).toBe('ny-2025-hr5');
    expect(n?.identifier).toBe('HR5');
  });

  it('returns null when the bill number does not form a valid DD1 key', () => {
    const n = normalizeLegiscanBill(fixtureBill({ bill_number: '', number: null }), 'TX');
    expect(n).toBeNull();
  });

  it('a special session bill folds the session_id into the key', () => {
    const n = normalizeLegiscanBill(
      fixtureBill({
        session: {
          session_id: 1987,
          year_start: 2025,
          year_end: 2025,
          session_name: '2025 1st Called Session',
          special: 1,
          prior: 0,
        },
      }),
      'TX',
    );
    expect(n?.billKey).toBe('tx-2025x1987-hb1234');
  });

  it('classifies unknown sast type_id as "related" rather than guessing', () => {
    const n = normalizeLegiscanBill(
      fixtureBill({ sasts: [{ type: 'Unknown', type_id: 99, sast_bill_id: 111 }] }),
      'TX',
    );
    expect(n?.links).toEqual([{ legiscanRelatedBillId: 111, linkType: 'related' }]);
  });

  it('drops a sast link with no resolvable target bill id', () => {
    const n = normalizeLegiscanBill(
      fixtureBill({ sasts: [{ type: 'Same As', type_id: 1 }] }),
      'TX',
    );
    expect(n?.links).toEqual([]);
  });

  it('normalizes a committee referral, mapping the LegiScan chamber code (Phase 1 M2.2)', () => {
    const n = normalizeLegiscanBill(
      fixtureBill({ committee: { committee_id: 410, chamber: 'H', name: 'State Affairs' } }),
      'TX',
    );
    expect(n?.committee).toEqual({
      legiscanCommitteeId: 410,
      name: 'State Affairs',
      chamber: 'lower',
    });
  });

  it('has a null committee when the bill is not currently in one', () => {
    const n = normalizeLegiscanBill(fixtureBill(), 'TX');
    expect(n?.committee).toBeNull();
  });
});

describe('normalizeLegiscanChamber', () => {
  it('maps House/Assembly codes to "lower" and Senate to "upper"', () => {
    expect(normalizeLegiscanChamber('H')).toBe('lower');
    expect(normalizeLegiscanChamber('A')).toBe('lower');
    expect(normalizeLegiscanChamber('S')).toBe('upper');
    expect(normalizeLegiscanChamber('h')).toBe('lower'); // case-insensitive
  });
  it('W4.1: also accepts spelled-out names and already-normalized forms (state_bill.chamber varies)', () => {
    expect(normalizeLegiscanChamber('House')).toBe('lower');
    expect(normalizeLegiscanChamber('Assembly')).toBe('lower');
    expect(normalizeLegiscanChamber('lower')).toBe('lower');
    expect(normalizeLegiscanChamber('Senate')).toBe('upper');
    expect(normalizeLegiscanChamber('upper')).toBe('upper');
    expect(normalizeLegiscanChamber('  UPPER  ')).toBe('upper'); // trimmed + case-insensitive
  });
  it('never guesses an unrecognized code', () => {
    expect(normalizeLegiscanChamber('X')).toBeNull();
    expect(normalizeLegiscanChamber('L')).toBeNull(); // e.g. NE unicameral — not disambiguable, never guess
    expect(normalizeLegiscanChamber(null)).toBeNull();
    expect(normalizeLegiscanChamber(undefined)).toBeNull();
  });
});

describe('resolveCurrentCommittee (Phase 1 M2.2)', () => {
  function fakePrisma(existing: Array<{ id: string; legiscanCommitteeId: number | null }> = []) {
    const upserts: unknown[] = [];
    return {
      client: {
        stateCommittee: {
          upsert: jest.fn(async (args: { where: { id: string }; create: unknown }) => {
            upserts.push(args);
            return existing.find((e) => e.id === args.where.id) ?? args.create;
          }),
        },
      } as unknown as PrismaClient,
      upserts,
    };
  }

  it('upserts state_committee using the SAME "<state>-<chamber>-<slug>" scheme as the OpenStates roster path', async () => {
    const { client, upserts } = fakePrisma();
    const id = await resolveCurrentCommittee(client, 'TX', {
      legiscanCommitteeId: 410,
      name: 'State Affairs',
      chamber: 'lower',
    });
    expect(id).toBe('TX-lower-state-affairs');
    expect(upserts).toHaveLength(1);
  });

  it('returns null (and never upserts) when the referral has no committee', async () => {
    const { client, upserts } = fakePrisma();
    const id = await resolveCurrentCommittee(client, 'TX', null);
    expect(id).toBeNull();
    expect(upserts).toHaveLength(0);
  });

  it('returns null (and never upserts/guesses) when the chamber could not be normalized', async () => {
    const { client, upserts } = fakePrisma();
    const id = await resolveCurrentCommittee(client, 'TX', {
      legiscanCommitteeId: 410,
      name: 'State Affairs',
      chamber: null,
    });
    expect(id).toBeNull();
    expect(upserts).toHaveLength(0);
  });
});

describe('crosswalkLegiscanPerson (S2 people crosswalk DB wrapper)', () => {
  interface Leg {
    id: string;
    name: string;
    district: string | null;
    party: string | null;
    chamber: string | null;
    legiscanPeopleId: number | null;
  }
  function fakePrisma(candidates: Leg[]) {
    const updates: Array<{ where: unknown; data: unknown }> = [];
    const crosswalks: unknown[] = [];
    const client = {
      stateLegislator: {
        findMany: jest.fn(async () =>
          candidates.map(({ id, name, district, party, chamber, legiscanPeopleId }) => ({
            id,
            name,
            district,
            party,
            chamber,
            legiscanPeopleId,
          })),
        ),
        findUnique: jest.fn(async (args: { where: { legiscanPeopleId: number } }) => {
          return candidates.find((c) => c.legiscanPeopleId === args.where.legiscanPeopleId) ?? null;
        }),
        update: jest.fn(async (args: { where: unknown; data: unknown }) => {
          updates.push(args);
          return {};
        }),
      },
      entityCrosswalk: {
        upsert: jest.fn(async (args: unknown) => {
          crosswalks.push(args);
          return {};
        }),
      },
    } as unknown as PrismaClient;
    return { client, updates, crosswalks };
  }

  it('stamps legiscan_people_id + an entity_crosswalk row on a confident match', async () => {
    const { client, updates, crosswalks } = fakePrisma([
      {
        id: 'os-1',
        name: 'John Smith',
        district: '12',
        party: 'D',
        chamber: 'lower',
        legiscanPeopleId: null,
      },
    ]);
    const ok = await crosswalkLegiscanPerson(client, 'TX', {
      people_id: 555,
      name: 'John Smith',
      district: '12',
      party: 'D',
      role_id: 1,
    });
    expect(ok).toBe(true);
    expect(updates).toEqual([{ where: { id: 'os-1' }, data: { legiscanPeopleId: 555 } }]);
    expect(crosswalks).toHaveLength(1);
  });

  it('returns false (no write) when the matcher cannot resolve a unique person (PD2)', async () => {
    const { client, updates, crosswalks } = fakePrisma([
      {
        id: 'os-a',
        name: 'John Smith',
        district: null,
        party: null,
        chamber: null,
        legiscanPeopleId: null,
      },
      {
        id: 'os-b',
        name: 'John Smith',
        district: null,
        party: null,
        chamber: null,
        legiscanPeopleId: null,
      },
    ]);
    const ok = await crosswalkLegiscanPerson(client, 'TX', { people_id: 5, name: 'John Smith' });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(crosswalks).toHaveLength(0);
  });

  it('does not steal a people_id already stamped on a different legislator (unique-key guard)', async () => {
    const { client, updates } = fakePrisma([
      // Matcher would pick os-new, but people_id 999 already belongs to os-old.
      {
        id: 'os-new',
        name: 'Jane Doe',
        district: '3',
        party: 'R',
        chamber: 'upper',
        legiscanPeopleId: null,
      },
      {
        id: 'os-old',
        name: 'Jane Doe (old)',
        district: '9',
        party: 'R',
        chamber: 'upper',
        legiscanPeopleId: 999,
      },
    ]);
    const ok = await crosswalkLegiscanPerson(client, 'TX', {
      people_id: 999,
      name: 'Jane Doe',
      district: '3',
      party: 'R',
      role_id: 2,
    });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
  });

  it('is idempotent: re-confirming the SAME legislator that already holds the id still succeeds', async () => {
    const { client, updates } = fakePrisma([
      {
        id: 'os-1',
        name: 'John Smith',
        district: '12',
        party: 'D',
        chamber: 'lower',
        legiscanPeopleId: 555,
      },
    ]);
    const ok = await crosswalkLegiscanPerson(client, 'TX', {
      people_id: 555,
      name: 'John Smith',
      district: '12',
      party: 'D',
      role_id: 1,
    });
    expect(ok).toBe(true);
    expect(updates).toEqual([{ where: { id: 'os-1' }, data: { legiscanPeopleId: 555 } }]);
  });

  it('does not overwrite a legislator already crosswalked to a DIFFERENT people_id', async () => {
    // os-1 already holds 100; a second person (200) that also matches by name
    // must not churn the stable stamp.
    const { client, updates, crosswalks } = fakePrisma([
      {
        id: 'os-1',
        name: 'John Smith',
        district: '12',
        party: 'D',
        chamber: 'lower',
        legiscanPeopleId: 100,
      },
    ]);
    const ok = await crosswalkLegiscanPerson(client, 'TX', {
      people_id: 200,
      name: 'John Smith',
      district: '12',
      party: 'D',
      role_id: 1,
    });
    expect(ok).toBe(false);
    expect(updates).toHaveLength(0);
    expect(crosswalks).toHaveLength(0);
  });
});
