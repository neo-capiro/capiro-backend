import {
  floridaCommitteeDirectoryProfile,
  floridaLegislatorDirectoryProfile,
} from './florida-directory-profile.js';

const sha = 'a'.repeat(64);

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
