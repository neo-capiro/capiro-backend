import { describe, expect, test } from 'vitest';
import { buildFactSheetLines, buildFundingCsv } from './Bill360Export.js';
import type { BillDossierResponse } from './bill-360.types.js';

/**
 * Bill 360 export provenance (Release R4, §4.5).
 *
 * An exported file is read OUT of context — months later, forwarded, printed. So the
 * guarantees under test are: every export states when it was generated and for whom,
 * every amount carries its fiscal-year / stage / vehicle / scope labels, every claim
 * carries its Official / Capiro analysis / Analyst outlook label, and the
 * same-scope-only comparability rule travels with the numbers.
 */

const GENERATED_AT = '2026-07-27T12:00:00.000Z';

function dossier(over: Partial<BillDossierResponse> = {}): BillDossierResponse {
  return {
    bill: {
      id: '119-hr-9100',
      num: 'H.R. 9100',
      title: 'Department of Defense Appropriations Act, 2027',
      chamber: 'House',
      type: 'hr',
      congress: 119,
      sponsor: 'Rep. Example',
      introduced: '2026-05-01T00:00:00.000Z',
      statusLabel: 'Passed chamber',
      statusSev: 'success',
      statusAt: '2026-07-10T00:00:00.000Z',
      stage: 'passed_chamber',
      jurisdiction: 'US',
      isState: false,
      url: 'https://congress.gov/bill/119/hr/9100',
    },
    latest: { text: 'Passed the House.', date: '2026-07-10T00:00:00.000Z' },
    context: {
      contextType: 'client',
      externalRef: '11111111-1111-1111-1111-111111111111',
      name: 'Acme Defense',
    },
    tracking: null,
    kpis: [
      { label: 'Current status', value: 'Passed chamber', sub: '2026-07-10' },
      { label: 'Funding position', value: '$850.0B', sub: 'defense_appropriations_title · house' },
    ],
    overview: {
      whatChanged: {
        origin: 'official',
        text: 'Passed the House.',
        asOf: '2026-07-10T00:00:00.000Z',
        source: 'Congress.gov',
      },
      whyItMatters: null,
      officialNextStep: null,
      analystOutlook: {
        origin: 'analyst',
        text: 'We expect conference to split the difference.',
        asOf: '2026-07-12T00:00:00.000Z',
        expires: '2026-09-30T00:00:00.000Z',
      },
    },
    milestones: [
      { date: '2026-07-10T00:00:00.000Z', label: 'Passed the House', detail: null, state: 'current' },
    ],
    votes: [
      {
        id: 'v1',
        label: 'On Passage',
        target: 'passage',
        chamber: 'house',
        date: '2026-07-10T00:00:00.000Z',
        result: 'Passed',
        resultSev: 'success',
        tally: '230-200',
        party: null,
        note: null,
      },
    ],
    governingRules: [],
    noVote: null,
    funding: {
      available: true,
      status: null,
      positions: [
        {
          scope: 'defense_appropriations_title',
          stage: 'house',
          vehicleClass: 'appropriation',
          amountMillions: 850000,
          effectiveDate: '2026-07-10T00:00:00.000Z',
          source: 'House defense appropriations',
          sourceUrl: 'https://example.invalid/hac-d',
          sourcePage: 4,
          verification: 'reviewed',
          primary: true,
          note: null,
        },
        {
          scope: 'defense_appropriations_title',
          stage: 'president',
          vehicleClass: 'request',
          amountMillions: 840000,
          effectiveDate: null,
          source: 'FY2027 request',
          sourceUrl: null,
          sourcePage: null,
          verification: 'verified',
          primary: false,
          note: null,
        },
      ],
      reqCompare: {
        scope: 'defense_appropriations_title',
        label: "President's request",
        amountMillions: 840000,
        deltaMillions: 10000,
        pct: 1.19,
        billId: null,
        comparable: true,
      },
      senateCompare: null,
      comparisons: [],
      guardrail: null,
      programElementImpacts: [
        {
          pe: '0603270A',
          name: 'Electronic Warfare Technology',
          requestMillions: 100,
          houseMillions: 120,
          senateMillions: null,
          deltaVsRequestMillions: 20,
          pct: 20,
          basis: 'inferred',
          source: 'title_match · candidate · confidence 0.55',
        },
      ],
      provisions: [],
      parentPackageLabel: 'FY27 Defense Budget',
    },
    relatedVehicles: [],
    hearings: [],
    alerts: [],
    matchedTopics: [],
    recommendedActions: [],
    provenance: {
      lastSyncedAt: '2026-07-11T00:00:00.000Z',
      sources: [
        {
          label: 'Congress.gov',
          as: '2026-07-10T00:00:00.000Z',
          origin: 'official',
          fresh: true,
          url: 'https://congress.gov/bill/119/hr/9100',
        },
        { label: 'Capiro alert analysis', as: null, origin: 'derived', fresh: false, url: null },
      ],
    },
    ...over,
  };
}

describe('buildFundingCsv — provenance and comparability', () => {
  test('states what it is, when it was generated, and for whom', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    expect(csv).toContain('Capiro Bill 360 — funding comparison');
    expect(csv).toContain('H.R. 9100');
    expect(csv).toContain('client: Acme Defense');
    expect(csv).toContain(GENERATED_AT);
    expect(csv).toContain('Last synced');
  });

  test('carries the same-FY, same-scope comparability rule with the numbers', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    expect(csv).toContain('same fiscal year AND the same funding scope');
  });

  test('every position row carries stage, vehicle class, scope, verification, and source', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    const header = csv.split('\r\n').find((l) => l.includes('Funding scope'))!;
    for (const col of [
      'Stage',
      'Vehicle class',
      'Funding scope',
      'Amount ($M)',
      'Verification',
      'Source',
      'Source page',
    ]) {
      expect(header).toContain(col);
    }
    // Human labels, not raw enum tokens.
    expect(csv).toContain('Defense appropriations title');
    expect(csv).toContain("President's request");
    expect(csv).toContain('Appropriation');
  });

  test('keeps authorization/appropriation and request rows as separate lines', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    const rows = csv.split('\r\n').filter((l) => l.includes('Defense appropriations title'));
    // Header + 2 position rows + the delta block's scope row.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(csv).toContain('850000');
    expect(csv).toContain('840000');
  });

  test('labels the delta block as same-FY/same-scope only', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    expect(csv).toContain('Delta vs request — SAME fiscal year and SAME scope only');
  });

  test('labels an inferred PE match as inferred, never explicit', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    expect(csv).toContain('Inferred match');
    expect(csv).not.toContain('Explicit PE match');
  });

  test('lists every source with its provenance class and freshness', () => {
    const csv = buildFundingCsv(dossier(), GENERATED_AT);
    expect(csv).toContain('Official');
    expect(csv).toContain('Capiro analysis');
    expect(csv).toContain('Current');
    expect(csv).toContain('Stale');
  });

  test('a funding-free bill exports the grounded status and NO position rows', () => {
    const d = dossier();
    const csv = buildFundingCsv(
      {
        ...d,
        funding: {
          ...d.funding,
          available: false,
          status: 'No reviewed funding positions are linked to this bill yet.',
          positions: [],
          reqCompare: null,
          programElementImpacts: [],
        },
      },
      GENERATED_AT,
    );
    expect(csv).toContain('No reviewed funding positions');
    expect(csv).not.toContain('Funding scope');
    expect(csv).not.toContain('850000');
  });

  test('escapes embedded quotes so a note cannot break the row structure', () => {
    const d = dossier();
    d.funding.positions[0]!.note = 'Committee said "increase" here';
    const csv = buildFundingCsv(d, GENERATED_AT);
    expect(csv).toContain('""increase""');
  });

  test('marks the global dossier as global, not as a client export', () => {
    const csv = buildFundingCsv(dossier({ context: null }), GENERATED_AT);
    expect(csv).toContain('Global (public dossier)');
    expect(csv).not.toContain('Acme Defense');
  });
});

describe('buildFactSheetLines — provenance travels with every claim', () => {
  const text = (d = dossier()) =>
    buildFactSheetLines(d, GENERATED_AT)
      .map((l) => l.text)
      .join('\n');

  test('leads with the bill, its canonical status, and the context', () => {
    const t = text();
    expect(t).toContain('H.R. 9100 — Department of Defense Appropriations Act, 2027');
    expect(t).toContain('Canonical status: Passed chamber');
    expect(t).toContain('client — Acme Defense');
    expect(t).toContain(`Generated at: ${GENERATED_AT}`);
  });

  test('labels an analyst forecast as an analyst outlook, with its expiry', () => {
    const t = text();
    expect(t).toContain('[Analyst outlook] Analyst outlook: We expect conference');
    expect(t).toContain('Valid to 2026-09-30');
  });

  test('labels an official fact as Official', () => {
    expect(text()).toContain('[Official] What changed: Passed the House.');
  });

  test('renders short dates, never raw ISO timestamps', () => {
    const t = text();
    expect(t).toContain('2026-07-10');
    expect(t).not.toContain('T00:00:00.000Z');
  });

  test('every funding line carries stage, vehicle class, scope, and verification', () => {
    const t = text();
    expect(t).toContain(
      'House · Appropriation · Defense appropriations title: $850.0B [Reviewed] (primary)',
    );
    expect(t).toContain('Source: House defense appropriations · p. 4');
  });

  test('states the comparability rule and the same-scope delta', () => {
    const t = text();
    expect(t).toContain('same fiscal year AND the same funding scope');
    expect(t).toContain('Delta vs request (Defense appropriations title): +$10.0B');
  });

  test('names the parent package without implying a navigable workspace', () => {
    expect(text()).toContain('Part of FY27 Defense Budget');
  });

  test('states an absent roll call explicitly instead of omitting the section', () => {
    const t = text(
      dossier({ votes: [], noVote: 'No roll call vote has been recorded on this bill.' }),
    );
    expect(t).toContain('No roll call vote has been recorded on this bill.');
  });

  test('a funding-free bill exports the grounded status and no fabricated $0', () => {
    const d = dossier();
    const t = text({
      ...d,
      funding: { ...d.funding, available: false, status: 'Funding data is not available.', positions: [] },
    });
    expect(t).toContain('Funding data is not available.');
    expect(t).not.toContain('$0M');
  });

  test('closes with the source list and the label legend', () => {
    const t = text();
    expect(t).toContain('[Official] Congress.gov');
    expect(t).toContain('[Capiro analysis] Capiro alert analysis');
    expect(t).toContain('(stale)');
    expect(t).toContain('Official / Capiro analysis / Analyst outlook labels are shown in brackets');
  });
});
