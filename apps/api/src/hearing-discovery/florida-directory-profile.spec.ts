import {
  floridaCommitteeDirectoryProfile,
  floridaDirectoryCommitteeAssignment,
  floridaLegislatorDirectoryProfile,
} from './florida-directory-profile.js';

const sha = 'a'.repeat(64);

describe('Florida directory committee assignments', () => {
  const key = 'FL:2026:fl:house:committee:3291';
  const name = 'Careers & Workforce Subcommittee';
  const source = { sha256: sha, asOfDate: '2026-06-04' };
  const committee = {
    officialSourceKey: key,
    name,
    sourceEvidence: {
      directoryPdf: {
        subject: { kind: 'committee', officialSourceKey: key, name },
        source,
      },
    },
  };
  const legislator = {
    state: 'FL',
    chamber: 'lower',
    district: '77',
    sourceEvidence: {
      directoryPdf: {
        subject: { kind: 'legislator', state: 'FL', chamber: 'lower', district: '77' },
        source,
        committeeAssignments: [{ name, role: 'Chair' }],
      },
    },
  };
  it('uses the source-bound assignment attached to a stable person', () => {
    expect(floridaDirectoryCommitteeAssignment(committee, legislator)).toEqual({
      role: 'Chair',
      asOfDate: '2026-06-04',
    });
  });
  it.each([{ state: 'GA' }, { chamber: 'upper' }, { district: '78' }, { district: null }])(
    'rejects conflicting person scope %j',
    (change) => {
      expect(
        floridaDirectoryCommitteeAssignment(committee, { ...legislator, ...change }),
      ).toBeNull();
    },
  );
  it('rejects other committee identities, editions and approximate names', () => {
    expect(
      floridaDirectoryCommitteeAssignment(
        { ...committee, officialSourceKey: key + '0' },
        legislator,
      ),
    ).toBeNull();
    expect(
      floridaDirectoryCommitteeAssignment({ ...committee, name: name.toLowerCase() }, legislator),
    ).toBeNull();
    const changed = structuredClone(legislator);
    changed.sourceEvidence.directoryPdf.source = { ...source, sha256: 'b'.repeat(64) };
    expect(floridaDirectoryCommitteeAssignment(committee, changed)).toBeNull();
  });
  it('never revives an assignment removed by the latest edition', () => {
    const old = legislator.sourceEvidence.directoryPdf;
    const person = {
      ...legislator,
      sourceEvidence: {
        directoryPdf: {
          observations: [
            old,
            { ...old, source: { ...source, asOfDate: '2026-08-01' }, committeeAssignments: [] },
          ],
        },
      },
    };
    expect(floridaDirectoryCommitteeAssignment(committee, person)).toBeNull();
  });
});

describe('Florida directory PDF projections', () => {
  it('deduplicates staff across verified committee aliases and preserves contact provenance', () => {
    const evidence = {
      directoryPdf: {
        jurisdiction: 'Considers insurance and financial institutions.',
        contacts: [{ location: '320 Knott Building', phone: '(850) 487-5361', voip: '5361' }],
        leadership: [{ name: 'Senator Gruters', role: 'Chair' }],
        staff: [{ name: 'James Knudson', role: 'Staff Director', sourcePage: 25 }],
        source: {
          document: 'SDIR.pdf',
          sha256: sha,
          asOfDate: '2026-08-26',
          pages: [25],
        },
      },
    };
    const profile = floridaCommitteeDirectoryProfile([
      { sourceEvidence: evidence },
      { sourceEvidence: evidence },
    ]);
    expect(profile).toMatchObject({
      jurisdiction: 'Considers insurance and financial institutions.',
      contacts: [{ location: '320 Knott Building', phone: '(850) 487-5361', voip: '5361' }],
      leadership: [{ name: 'Senator Gruters', role: 'Chair' }],
      staff: [{ name: 'James Knudson', role: 'Staff Director', sourcePage: 25 }],
      sources: [{ document: 'SDIR.pdf', sha256: sha, asOfDate: '2026-08-26', pages: [25] }],
    });
    expect(profile?.staff).toHaveLength(1);
  });

  it('keeps House and Senate observations for one joint body source-bound', () => {
    const profile = floridaCommitteeDirectoryProfile([
      {
        sourceEvidence: {
          directoryPdf: {
            observations: [
              {
                contacts: [{ location: '214 House Office Building' }],
                staff: [{ name: 'Alex Staff', role: 'Staff Director', sourcePage: 73 }],
                source: {
                  document: 'HouseDirectory.pdf',
                  sha256: 'b'.repeat(64),
                  asOfDate: '2026-06-04',
                  pages: [73],
                },
              },
              {
                contacts: [{ location: '525 Knott Building' }],
                staff: [{ name: 'Alex Staff', role: 'Staff Director', sourcePage: 29 }],
                source: {
                  document: 'SDIR.pdf',
                  sha256: 'c'.repeat(64),
                  asOfDate: '2026-08-26',
                  pages: [29],
                },
              },
            ],
          },
        },
      },
    ]);
    expect(profile?.contacts).toHaveLength(2);
    expect(profile?.staff).toHaveLength(1);
    expect(profile?.sources.map((source) => source.document)).toEqual([
      'SDIR.pdf',
      'HouseDirectory.pdf',
    ]);
  });

  it('returns only validated legislator directory facts', () => {
    expect(
      floridaLegislatorDirectoryProfile({
        directoryPdf: {
          email: 'president@flsenate.gov',
          portrait: { publicUrl: '/florida-directory/portraits/house-district-027.jpg' },
          leadershipTitle: 'President',
          offices: [{ kind: 'capitol', phone: '(850) 487-5027' }],
          staff: [{ name: 'Patty Harrison', role: 'Legislative Aide' }],
          source: {
            document: 'SDIR.pdf',
            sha256: sha,
            asOfDate: '2026-08-26',
            pages: [4],
          },
        },
      }),
    ).toMatchObject({
      email: 'president@flsenate.gov',
      portraitUrl: '/florida-directory/portraits/house-district-027.jpg',
      leadershipTitle: 'President',
      offices: [{ kind: 'capitol', phone: '(850) 487-5027' }],
      staff: [{ name: 'Patty Harrison', role: 'Legislative Aide' }],
    });
    expect(floridaLegislatorDirectoryProfile({ directoryPdf: { source: {} } })).toBeNull();
    expect(
      floridaLegislatorDirectoryProfile({
        directoryPdf: {
          email: 'president@flsenate.gov',
          source: { sha256: sha, asOfDate: 'August 26, 2026' },
        },
      })?.source.asOfDate,
    ).toBeNull();
  });
});
