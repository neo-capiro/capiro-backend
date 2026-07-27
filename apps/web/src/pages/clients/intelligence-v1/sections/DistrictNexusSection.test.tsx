import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictNexusSection } from './DistrictNexusSection.js';

/**
 * REGRESSION (2026-07-10, Wave-2 closure / W2.2): both the district-nexus query
 * and the representation query must render a DISTINCT error state on a failed
 * fetch — never fall through to the "No federal contractor linked yet" empty
 * state (which would wrongly tell the user to go map a contractor) or to
 * rendering nothing (indistinguishable from "this client has no facilities").
 * These pin the isError branches added in W2.2 so a future ternary reorder that
 * regresses error→empty is caught.
 */

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: vi.fn() }) }));

const getNexusMock = vi.fn();
const getNexusV2Mock = vi.fn();
const getRepMock = vi.fn();
// A vi.mock factory replaces the WHOLE module namespace, so every named import
// the component uses must be returned here — omitting getClientDistrictNexusV2
// throws "No export is defined on the mock" and breaks the legacy tests too.
vi.mock('../district-nexus-api.js', () => ({
  getClientDistrictNexus: (...args: unknown[]) => getNexusMock(...args),
  getClientDistrictNexusV2: (...args: unknown[]) => getNexusV2Mock(...args),
}));
vi.mock('../representation-api.js', () => ({
  getClientRepresentation: (...args: unknown[]) => getRepMock(...args),
}));

// Defaults OFF so every pre-existing test keeps exercising the legacy widget.
let flagEnabled = false;
let flagReady = true;
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: flagEnabled, ready: flagReady }),
}));

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DistrictNexusSection clientId="abc" />
    </QueryClientProvider>,
  );
}

describe('DistrictNexusSection error states (W2.2)', () => {
  beforeEach(() => {
    flagEnabled = false;
    flagReady = true;
    getNexusMock.mockReset();
    getNexusV2Mock.mockReset();
    getRepMock.mockReset();
  });

  test('a district-nexus fetch error shows a distinct error notice, NOT the "no contractor linked" empty state', async () => {
    getNexusMock.mockRejectedValue(new Error('boom'));
    getRepMock.mockResolvedValue([]);
    renderSection();
    await waitFor(() => expect(screen.getByText(/Couldn't load district nexus/i)).toBeTruthy());
    // The failure must NOT be misrepresented as "you haven't mapped a contractor".
    expect(screen.queryByText(/No federal contractor linked yet/i)).toBeNull();
  });

  test('a representation fetch error shows the representatives error notice (not silent nothing)', async () => {
    getNexusMock.mockResolvedValue({ linked: false });
    getRepMock.mockRejectedValue(new Error('boom'));
    renderSection();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this client's representatives/i)).toBeTruthy(),
    );
  });
});

describe('DistrictNexusSection WS-B "View district" link', () => {
  beforeEach(() => {
    flagEnabled = false;
    flagReady = true;
    getNexusMock.mockReset();
    getNexusV2Mock.mockReset();
    getRepMock.mockReset();
    getRepMock.mockResolvedValue([]);
  });

  const baseRow = {
    district: 'TX-23',
    state: 'TX',
    awardCount: 1,
    totalAmount: 100,
    demographics: null,
  };

  test('links to the district-detail page when the House seat resolved', async () => {
    getNexusMock.mockResolvedValue({
      linked: true,
      contractorNames: ['Acme'],
      totalAwards: 1,
      totalAmount: 100,
      districtCount: 1,
      unmappedAmount: 0,
      disclaimer: '',
      districts: [
        {
          ...baseRow,
          representatives: {
            house: { bioguideId: 'H1', fullName: 'Jane Doe', party: 'R' },
            senate: [],
          },
        },
      ],
    });
    renderSection();
    await waitFor(() => expect(screen.getByText('View district →')).toBeTruthy());
    expect(screen.getByText('View district →').closest('a')).toHaveAttribute(
      'href',
      '/directory/districts/TX/23',
    );
  });

  test('renders the at-large ("00") path for an at-large district', async () => {
    getNexusMock.mockResolvedValue({
      linked: true,
      contractorNames: ['Acme'],
      totalAwards: 1,
      totalAmount: 100,
      districtCount: 1,
      unmappedAmount: 0,
      disclaimer: '',
      districts: [
        {
          ...baseRow,
          district: 'WY-AL',
          state: 'WY',
          representatives: {
            house: { bioguideId: 'H2', fullName: 'John Roe', party: 'R' },
            senate: [],
          },
        },
      ],
    });
    renderSection();
    await waitFor(() => expect(screen.getByText('View district →')).toBeTruthy());
    expect(screen.getByText('View district →').closest('a')).toHaveAttribute(
      'href',
      '/directory/districts/WY/00',
    );
  });

  test('omits the link when the House seat could not be resolved (delegate/undefined sentinel)', async () => {
    getNexusMock.mockResolvedValue({
      linked: true,
      contractorNames: ['Acme'],
      totalAwards: 1,
      totalAmount: 100,
      districtCount: 1,
      unmappedAmount: 0,
      disclaimer: '',
      districts: [{ ...baseRow, representatives: { house: null, senate: [] } }],
    });
    renderSection();
    await waitFor(() => expect(screen.getByText('TX-23')).toBeTruthy());
    expect(screen.queryByText('View district →')).toBeNull();
  });
});

/**
 * WS-H: the v2 widget behind the `district_nexus_v2` flag. One query instead of
 * two, awarded grants alongside contracts, explainable per-district scores, and
 * a gap list that says WHY a number is missing rather than leaving it blank.
 */
describe('DistrictNexusSection v2 (WS-H, flag on)', () => {
  beforeEach(() => {
    flagEnabled = true;
    flagReady = true;
    getNexusMock.mockReset();
    getNexusV2Mock.mockReset();
    getRepMock.mockReset();
    getRepMock.mockResolvedValue([]);
  });

  /** Text of the whole section, for "this string must never appear" assertions. */
  function sectionText(): string {
    return document.getElementById('district-nexus')?.textContent ?? '';
  }

  function districtFixture(overrides: Record<string, unknown> = {}) {
    return {
      districtKey: 'TX-23',
      state: 'TX',
      districtCode: '23',
      status: 'C',
      name: null,
      awarded: {
        contractObligations: 5_000_000,
        grantObligations: 2_000_000,
        grantOutlays: 1_000_000,
      },
      opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
      clientCount: 1,
      score: 62,
      coveragePercent: 70,
      employeeCount: 100,
      employeesUnreported: false,
      warnings: [],
      evidence: [],
      breakdown: [
        {
          component: 'contractPlaceOfPerformance',
          label: 'Contract place of performance',
          weight: 20,
          credit: 20,
          rationale: '',
          evidenceCount: 1,
        },
        {
          component: 'grantPlaceOfPerformance',
          label: 'Grant place of performance',
          weight: 10,
          credit: 0,
          rationale: '',
          evidenceCount: 0,
        },
      ],
      freshness: [],
      ...overrides,
    };
  }

  function v2Fixture(overrides: Record<string, unknown> = {}) {
    return {
      clientId: 'abc',
      districts: [],
      representativesByFacility: [],
      linkage: {
        contractingLinked: true,
        contractorNames: ['Acme Defense'],
        assistanceLinked: true,
        recipientNames: ['Acme Research Institute'],
        ueiConfirmedCount: 1,
      },
      facilityFootprint: {
        facilityCount: 1,
        facilitiesWithoutDistrict: 0,
        employeeCount: 100,
        facilitiesMissingEmployeeCount: 0,
      },
      awarded: {
        contractObligations: 5_000_000,
        grantObligations: 2_000_000,
        grantOutlays: 1_000_000,
      },
      opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
      opportunitySummary: {
        activeOpportunityCount: 0,
        closedOpportunityCount: 0,
        totalEstimatedFunding: null,
        maximumAwardCeiling: null,
        topOpportunities: [],
      },
      unmapped: { unmappedContractAmount: null, unmappedGrantAmount: null },
      score: 62,
      bestDistrictKey: 'TX-23',
      coveragePercent: 70,
      breakdown: [],
      strongestDrivers: [],
      freshness: [],
      warnings: [],
      generatedAt: '2026-07-26T12:00:00.000Z',
      ...overrides,
    };
  }

  test('flag OFF still calls the legacy fetcher and never the v2 one', async () => {
    flagEnabled = false;
    getNexusMock.mockResolvedValue({ linked: false });
    renderSection();
    await waitFor(() => expect(screen.getByText(/No federal contractor linked yet/i)).toBeTruthy());
    expect(getNexusMock).toHaveBeenCalled();
    expect(getNexusV2Mock).not.toHaveBeenCalled();
  });

  test('fires ONE query: v2 only, and never the separate representation query', async () => {
    getNexusV2Mock.mockResolvedValue(v2Fixture());
    renderSection();
    await waitFor(() => expect(screen.getByText('Contract obligations')).toBeTruthy());
    expect(getNexusV2Mock).toHaveBeenCalledTimes(1);
    expect(getRepMock).not.toHaveBeenCalled();
    expect(getNexusMock).not.toHaveBeenCalled();
  });

  test('representatives render from the embedded representativesByFacility', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        representativesByFacility: [
          {
            facility: { id: 'f1', name: 'Plant One', city: 'Austin', state: 'TX' },
            representation: {
              unresolved: false,
              federal: {
                house: {
                  bioguideId: 'H1',
                  fullName: 'Jane Doe',
                  party: 'R',
                  state: 'TX',
                  district: 23,
                  chamber: 'house',
                },
                senate: [],
              },
              state: { lower: null, upper: null },
            },
          },
        ],
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeTruthy());
    expect(screen.getByText('Your representatives')).toBeTruthy();
  });

  test('"View full map →" deep-links to the WS-G firm map seeded with this client', async () => {
    getNexusV2Mock.mockResolvedValue(v2Fixture());
    renderSection();
    await waitFor(() => expect(screen.getByText('View full map →')).toBeTruthy());
    expect(screen.getByText('View full map →').closest('a')).toHaveAttribute(
      'href',
      '/intelligence/district-nexus?clientId=abc',
    );
  });

  test('"View district →" links to the padded district page (TX-23)', async () => {
    getNexusV2Mock.mockResolvedValue(v2Fixture({ districts: [districtFixture()] }));
    renderSection();
    await waitFor(() => expect(screen.getByText('View district →')).toBeTruthy());
    expect(screen.getByText('View district →').closest('a')).toHaveAttribute(
      'href',
      '/directory/districts/TX/23',
    );
  });

  test('"View district →" keeps the at-large "00" form (WY-00)', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        districts: [districtFixture({ districtKey: 'WY-00', state: 'WY', districtCode: '00' })],
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('View district →')).toBeTruthy());
    expect(screen.getByText('View district →').closest('a')).toHaveAttribute(
      'href',
      '/directory/districts/WY/00',
    );
  });

  test('a null Money renders an em dash, NEVER $0', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        awarded: { contractObligations: 5_000_000, grantObligations: null, grantOutlays: null },
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('Grant obligations')).toBeTruthy());
    const tile = screen.getByText('Grant obligations').closest('.iv1-dnx-stat');
    expect(tile?.querySelector('.iv1-dnx-stat-n')?.textContent).toBe('—');
    expect(sectionText()).not.toContain('$0');
  });

  test('a null score renders "Unscored", never "Minimal"', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({ districts: [districtFixture({ score: null, coveragePercent: 12 })] }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('Unscored')).toBeTruthy());
    expect(screen.queryByText('Minimal')).toBeNull();
    expect(sectionText()).toContain('too little evidence to score');
  });

  test('unconfirmed contracting renders the contracting gap and its mapping link', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        linkage: {
          contractingLinked: false,
          contractorNames: [],
          assistanceLinked: true,
          recipientNames: ['Acme Research Institute'],
          ueiConfirmedCount: 1,
        },
      }),
    );
    renderSection();
    await waitFor(() =>
      expect(screen.getByText(/No federal contractor is confirmed for this client/i)).toBeTruthy(),
    );
    expect(screen.getByText('Map a federal contractor →').closest('a')).toHaveAttribute(
      'href',
      '/settings/intelligence-mappings?source=contracting',
    );
  });

  test('contracting linked but assistance not renders ONLY the assistance gap', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        linkage: {
          contractingLinked: true,
          contractorNames: ['Acme Defense'],
          assistanceLinked: false,
          recipientNames: [],
          ueiConfirmedCount: 0,
        },
      }),
    );
    renderSection();
    await waitFor(() =>
      expect(
        screen.getByText(/No federal assistance recipient is confirmed for this client/i),
      ).toBeTruthy(),
    );
    expect(screen.getByText('Map an assistance recipient →').closest('a')).toHaveAttribute(
      'href',
      '/settings/intelligence-mappings?source=assistance_recipient',
    );
    expect(screen.queryByText(/No federal contractor is confirmed/i)).toBeNull();
  });

  test('assistance mapped without a UEI is its own distinct gap', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        linkage: {
          contractingLinked: true,
          contractorNames: ['Acme Defense'],
          assistanceLinked: true,
          recipientNames: ['Acme Research Institute'],
          ueiConfirmedCount: 0,
        },
      }),
    );
    renderSection();
    // Audit F1/honesty defects (h4): the backend DOES fall back to a
    // recipient-name match, so the old "cannot be matched" copy was wrong —
    // see DistrictNexusSection.tsx's corrected gap text.
    await waitFor(() =>
      expect(screen.getByText(/No verified UEI is attached to the confirmed assistance mapping/i)).toBeTruthy(),
    );
    expect(screen.getByText('Add a UEI to the mapping →')).toBeTruthy();
    // "not mapped" and "mapped but unusable" are different facts.
    expect(screen.queryByText(/No federal assistance recipient is confirmed/i)).toBeNull();
  });

  test('facilities on file but none geocoded does NOT claim there are no facilities', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        districts: [],
        facilityFootprint: {
          facilityCount: 2,
          facilitiesWithoutDistrict: 2,
          employeeCount: 50,
          facilitiesMissingEmployeeCount: 0,
        },
      }),
    );
    renderSection();
    await waitFor(() =>
      expect(screen.getByText(/no resolved congressional district/i)).toBeTruthy(),
    );
    expect(sectionText()).toContain('2 facilities have');
    expect(screen.queryByText(/No client facilities are on file/i)).toBeNull();
  });

  test('a partially-reported headcount renders "420+"', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        facilityFootprint: {
          facilityCount: 3,
          facilitiesWithoutDistrict: 0,
          employeeCount: 420,
          facilitiesMissingEmployeeCount: 1,
        },
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('Employees')).toBeTruthy());
    const tile = screen.getByText('Employees').closest('.iv1-dnx-stat');
    expect(tile?.querySelector('.iv1-dnx-stat-n')?.textContent).toBe('420+');
  });

  test('an entirely unreported headcount renders an em dash, not 0', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        facilityFootprint: {
          facilityCount: 2,
          facilitiesWithoutDistrict: 0,
          employeeCount: null,
          facilitiesMissingEmployeeCount: 2,
        },
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('Employees')).toBeTruthy());
    const tile = screen.getByText('Employees').closest('.iv1-dnx-stat');
    expect(tile?.querySelector('.iv1-dnx-stat-n')?.textContent).toBe('—');
    expect(tile?.querySelector('.iv1-dnx-stat-n')?.textContent).not.toBe('0');
  });

  test('a district with unreported employees gets the "+" suffix on its row', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        districts: [districtFixture({ employeeCount: 420, employeesUnreported: true })],
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('TX-23')).toBeTruthy());
    expect(sectionText()).toContain('420+ employees');
  });

  test('a non-404 failure shows the error notice, not a false "no data" state', async () => {
    getNexusV2Mock.mockRejectedValue(new Error('boom'));
    renderSection();
    await waitFor(() => expect(screen.getByText(/Couldn't load district nexus/i)).toBeTruthy());
    expect(screen.queryByText(/No federal contractor linked yet/i)).toBeNull();
    expect(screen.queryByText(/No district nexus yet/i)).toBeNull();
  });

  test('a 404 is a configuration fact and falls back to the legacy widget', async () => {
    getNexusV2Mock.mockRejectedValue({ response: { status: 404 } });
    getNexusMock.mockResolvedValue({ linked: false });
    renderSection();
    await waitFor(() => expect(screen.getByText(/No federal contractor linked yet/i)).toBeTruthy());
    expect(getNexusMock).toHaveBeenCalled();
    // A configuration skew must not surface as an outage.
    expect(screen.queryByText(/Couldn't load district nexus/i)).toBeNull();
  });

  test('the three freshness states are rendered distinguishably', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        freshness: [
          {
            source: 'sync-census',
            label: 'District demographics',
            lastSyncedAt: null,
            neverSynced: false,
            freshnessUnavailable: true,
          },
          {
            source: 'geocode-facilities',
            label: 'Client facilities and geocoding',
            lastSyncedAt: null,
            neverSynced: false,
            freshnessUnavailable: true,
          },
          {
            source: 'sync-federal-award',
            label: 'Federal contract awards',
            lastSyncedAt: null,
            neverSynced: true,
          },
          {
            source: 'sync-federal-assistance-awards',
            label: 'Federal assistance awards',
            lastSyncedAt: '2026-07-20T12:00:00.000Z',
            neverSynced: false,
          },
        ],
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText(/^Sources — /)).toBeTruthy());
    const text = sectionText();
    // Three DIFFERENT facts: unknown vs never synced vs an actual date.
    expect(text).toContain('Client facilities and geocoding: freshness unknown');
    expect(text).toContain('Federal contract awards: never synced');
    expect(text).toMatch(/Federal assistance awards: \d{1,2}\/\d{1,2}\/\d{4}/);
    // sync-census is not a rail this widget's numbers rest on.
    expect(text).not.toContain('District demographics');
  });

  test('no opportunity pipeline block renders when the client has none linked', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
        // Default v2Fixture() opportunitySummary is already the honest
        // all-zero shape; restated here for the test's own clarity.
        opportunitySummary: {
          activeOpportunityCount: 0,
          closedOpportunityCount: 0,
          totalEstimatedFunding: null,
          maximumAwardCeiling: null,
          topOpportunities: [],
        },
        freshness: [],
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('Contract obligations')).toBeTruthy());
    const text = sectionText();
    expect(screen.queryByText(/opportunity pipeline/i)).toBeNull();
    expect(text).not.toMatch(/\d+\s+[a-z ]*opportunit/i);
    expect(text).not.toMatch(/(four|three|two|one)\s+[a-z ]*opportunit/i);
  });

  test('a populated opportunity pipeline renders its own rail, never blended into the grant line', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        opportunitySummary: {
          activeOpportunityCount: 2,
          closedOpportunityCount: 1,
          totalEstimatedFunding: 4_500_000,
          maximumAwardCeiling: 3_000_000,
          topOpportunities: [
            {
              opportunityId: 'opp-1',
              title: 'Advanced Manufacturing R&D',
              agency: 'DOD',
              status: 'posted',
              closeDate: '2026-09-01T00:00:00.000Z',
              responseDateDesc: null,
              isActive: true,
              estimatedFunding: 3_000_000,
              awardCeiling: 3_000_000,
              relevanceScore: 72,
              eligibilityState: 'needs_review',
              eligibilityReason: 'No applicant-type data on file for this client.',
              matchedSignals: [{ signal: 'priorAssistanceListing', weight: 60, matchedOn: '12.345' }],
              districtKey: null,
            },
          ],
        },
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText(/Opportunity pipeline/i)).toBeTruthy());
    const text = sectionText();
    expect(text).toContain('2 active');
    expect(text).toContain('1 closed or archived');
    expect(text).toContain('Advanced Manufacturing R&D');
    expect(text).toContain('needs review');
    // Never blended into the grant-obligations line.
    expect(text).not.toMatch(/outlays[^.]*Opportunity pipeline/i);
  });

  test('unmapped contract and grant money is reported separately, never summed', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        districts: [districtFixture()],
        unmapped: { unmappedContractAmount: 5_000_000, unmappedGrantAmount: 250_000 },
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText(/^Unmapped — contracts/)).toBeTruthy());
    const text = sectionText();
    expect(text).toContain('$5.0M');
    expect(text).toContain('$250K');
    // 5,250,000 would be the blended figure — it must not appear.
    expect(text).not.toContain('$5.3M');
  });

  test('duplicate warning codes are de-duped to one line', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        warnings: [
          { code: 'statewide_attribution', message: 'Statewide money is not attributed.' },
          { code: 'statewide_attribution', message: 'Statewide money is not attributed.' },
          { code: 'unmapped_amount', message: 'Some amounts are unmapped.' },
        ],
      }),
    );
    renderSection();
    await waitFor(() =>
      expect(screen.getByText('Statewide money is not attributed.')).toBeTruthy(),
    );
    expect(screen.getAllByText('Statewide money is not attributed.')).toHaveLength(1);
    expect(screen.getByText('Some amounts are unmapped.')).toBeTruthy();
  });

  test('more districts than the cap says so rather than silently truncating', async () => {
    const districts = ['TX-23', 'VA-11', 'CA-12', 'NY-03', 'FL-07', 'OH-04'].map((districtKey) =>
      districtFixture({ districtKey, state: districtKey.slice(0, 2) }),
    );
    getNexusV2Mock.mockResolvedValue(v2Fixture({ districts }));
    renderSection();
    await waitFor(() => expect(screen.getByText('Top districts')).toBeTruthy());
    expect(sectionText()).toContain('showing top 5 of 6');
    expect(screen.queryByText('OH-04')).toBeNull();
  });

  test('every rail linked and geocoded but nothing resolved says exactly that', async () => {
    // §4 edge case 1: this must NOT be a blank section and must NOT claim a
    // contractor is unmapped — the identifiers are fine, the geography isn't.
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        districts: [],
        facilityFootprint: {
          facilityCount: 2,
          facilitiesWithoutDistrict: 0,
          employeeCount: 90,
          facilitiesMissingEmployeeCount: 0,
        },
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('No district nexus yet')).toBeTruthy());
    expect(screen.getByText(/nothing resolved to a district/i)).toBeTruthy();
    expect(screen.queryByText(/No federal contractor is confirmed/i)).toBeNull();
    expect(screen.queryByText(/No federal assistance recipient is confirmed/i)).toBeNull();
    expect(screen.queryByText(/No client facilities are on file/i)).toBeNull();
    expect(screen.queryByText(/no resolved congressional district/i)).toBeNull();
  });

  test('while the flag is still resolving the shell keeps id="district-nexus"', async () => {
    // §4 edge case 10 / O-8(b): rendering V1 during this window would flash
    // "No federal contractor linked yet" (a disabled TanStack v5 query reports
    // isLoading === false with data === undefined). The scroll-spy also keys on
    // this id, so it must exist on EVERY render path.
    flagReady = false;
    renderSection();
    expect(document.getElementById('district-nexus')).toBeTruthy();
    expect(screen.getByText('Loading district nexus…')).toBeTruthy();
    expect(screen.queryByText(/No federal contractor linked yet/i)).toBeNull();
    expect(getNexusMock).not.toHaveBeenCalled();
    expect(getNexusV2Mock).not.toHaveBeenCalled();
  });

  test('a breakdown with no credited component says so instead of showing nothing', async () => {
    getNexusV2Mock.mockResolvedValue(
      v2Fixture({
        districts: [
          districtFixture({
            breakdown: [
              {
                component: 'contractPlaceOfPerformance',
                label: 'Contract place of performance',
                weight: 20,
                credit: 0,
                rationale: '',
                evidenceCount: 0,
              },
            ],
          }),
        ],
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText('No scored evidence')).toBeTruthy());
  });
});
