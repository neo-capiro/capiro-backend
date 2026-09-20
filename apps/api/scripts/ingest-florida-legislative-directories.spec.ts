import {
  buildPlan,
  mergeObservation,
  namesCompatible,
  officialKey,
  planHash,
  type FloridaDirectoryManifest,
} from './ingest-florida-legislative-directories.js';

const houseSha = 'd22307e5f0809fc19fb3e3964232542b288a95d868e021f8813ccbee893a37cc';
const senateSha = 'f39f6880aef73025919a73eefbc12da6f1ba23b7d547766473f8a3d1a58c152d';

const inventory = {
  rows: [{ chamber: 'house' as const, officialCode: '3277', name: 'Agriculture Committee' }],
};

const manifest = {
  schemaVersion: 1,
  parserVersion: '1.0.0',
  jurisdiction: 'FL',
  legislativeSession: '2026',
  sources: {
    houseDirectory: {
      filename: 'HouseDirectory.pdf',
      sha256: houseSha,
      asOfDate: '2026-06-04',
      pageCount: 182,
    },
    senateDirectory: {
      filename: 'SDIR.pdf',
      sha256: senateSha,
      asOfDate: '2026-08-26',
      pageCount: 33,
    },
    officialCommitteeInventory: { sha256: 'a'.repeat(64) },
  },
  counts: {},
  validation: {},
  house: {
    members: [
      {
        chamber: 'house' as const,
        district: 2,
        name: 'Robert Alexander “Alex” Andrade',
        vacant: false,
        leadershipTitles: [],
        committeeMemberships: [{ committeeName: 'Agriculture Committee', role: null }],
        contact: {
          email: 'Alex.Andrade@FLHouse.gov',
          capitolOfficeRaw: '1301 The Capitol\nTallahassee, FL 32399\n(850) 717-5002',
          capitolPhones: ['(850) 717-5002'],
          districtOfficesRaw: '123 Main Street\nPensacola, FL 32501\n(850) 555-0102',
          districtPhones: ['(850) 555-0102'],
        },
        legislativeStaff: [{ role: 'Legislative Aide', names: ['Ada Aide'] }],
        portrait: {
          publicUrl: '/florida-directory/portraits/house-district-002-alex-andrade.jpg',
          filename: 'house-district-002-alex-andrade.jpg',
          mediaType: 'image/jpeg',
          sha256: 'b'.repeat(64),
          width: 209,
          height: 279,
          source: { pageNumber: 80, imageName: 'Im0' },
        },
        provenance: {
          pageNumber: 80,
          sourceId: 'houseDirectory',
          sourceSha256: houseSha,
          textSha256: 'c'.repeat(64),
        },
      },
    ],
    committees: [
      {
        chamber: 'house' as const,
        name: 'Agriculture Committee',
        officialCode: '3277',
        contactLine: '214 House Office Building | Tallahassee, FL | (850) 555-0100',
        phones: ['(850) 555-0100'],
        description: 'Reviews agriculture legislation.',
        leadership: [{ name: 'Andrade', role: 'Chair', party: 'R' }],
        staff: [{ name: 'Casey Staffer', role: 'Staff Director' }],
        roster: [{ name: 'Andrade', party: 'R' }],
        sources: [
          {
            provenance: {
              pageNumber: 39,
              sourceId: 'houseDirectory',
              sourceSha256: houseSha,
              textSha256: 'd'.repeat(64),
            },
          },
        ],
      },
    ],
    officeDirectoryPages: [],
  },
  senate: { members: [], committees: [], meetingRooms: [], officeDirectoryPages: [] },
  ambiguities: [],
} as unknown as FloridaDirectoryManifest;

describe('Florida directory PDF ingestion plan', () => {
  it('accepts formal/nickname variants only after the exact chamber+district match', () => {
    expect(namesCompatible('Alex Andrade', 'Robert Alexander “Alex” Andrade')).toBe(true);
    expect(namesCompatible('Jason Pizzo', 'PIZZO, Jason W. B.')).toBe(true);
    expect(namesCompatible('Someone Else', 'Robert Alexander Andrade')).toBe(false);
  });

  it('matches committees only through the reviewed official source key', () => {
    expect(officialKey(inventory.rows[0]!)).toBe('FL:2026:fl:house:committee:3277');
    const plan = buildPlan(
      manifest,
      inventory,
      [
        {
          id: 'ocd-person/alex',
          name: 'Alex Andrade',
          state: 'FL',
          chamber: 'lower',
          district: '2',
          email: null,
          active: true,
          sourceEvidence: { openstates: { retained: true } },
        },
      ],
      [
        {
          id: 'official-ag',
          name: 'Agriculture Committee',
          chamber: 'lower',
          officialSourceKey: 'FL:2026:fl:house:committee:3277',
          sourceEvidence: { directory: { retained: true } },
        },
      ],
    );
    expect(plan.unresolved).toEqual([]);
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes.map((write) => `${write.kind}:${write.id}`)).toEqual([
      'legislator:ocd-person/alex',
      'committee:official-ag',
    ]);

    const noExactCommittee = buildPlan(
      manifest,
      inventory,
      [],
      [
        {
          id: 'name-only',
          name: 'Agriculture Committee',
          chamber: 'lower',
          officialSourceKey: null,
          sourceEvidence: null,
        },
      ],
    );
    expect(noExactCommittee.unresolved).toEqual(
      expect.arrayContaining([expect.stringContaining('expected one official row, found 0')]),
    );
  });

  it('appends immutable source-versioned observations while preserving other evidence', () => {
    const plan = buildPlan(
      manifest,
      inventory,
      [
        {
          id: 'ocd-person/alex',
          name: 'Alex Andrade',
          state: 'FL',
          chamber: 'lower',
          district: '2',
          email: null,
          active: true,
          sourceEvidence: { openstates: { retained: true } },
        },
      ],
      [
        {
          id: 'official-ag',
          name: 'Agriculture Committee',
          chamber: 'lower',
          officialSourceKey: 'FL:2026:fl:house:committee:3277',
          sourceEvidence: null,
        },
      ],
    );
    const write = plan.writes[0]!;
    const first = mergeObservation(write.priorSourceEvidence, write.observation);
    expect(first.status).toBe('inserted');
    expect(first.value.openstates).toEqual({ retained: true });
    const observations = (first.value.directoryPdf as { observations: unknown[] }).observations;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ source: { sha256: houseSha } });
    expect(mergeObservation(first.value, write.observation).status).toBe('unchanged');

    const senateObservation = {
      ...write.observation,
      source: {
        document: 'SDIR.pdf',
        sha256: senateSha,
        asOfDate: '2026-08-26',
        pages: [29],
      },
    };
    const joined = mergeObservation(first.value, senateObservation);
    expect(
      (
        joined.value.directoryPdf as { observations: Array<{ source: { sha256: string } }> }
      ).observations.map((observation) => observation.source.sha256),
    ).toEqual([senateSha, houseSha]);

    const changed = {
      ...write.observation,
      email: 'different@flhouse.gov',
    };
    expect(() => mergeObservation(first.value, changed)).toThrow(
      /Conflicting directory observation/,
    );
  });

  it('produces a deterministic plan hash', () => {
    const plan = buildPlan(manifest, inventory, [], []);
    expect(planHash('e'.repeat(64), plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(planHash('e'.repeat(64), plan)).toBe(planHash('e'.repeat(64), plan));
  });
});
