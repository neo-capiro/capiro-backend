import type { IntelligenceService } from '../../src/intelligence/intelligence.service.js';
import type { OfficeRecommendation } from '../../src/intelligence/office-recommender.service.js';
import { trackedBill, hearing, type Options } from './intelligence-profile-v1.js';

type Payload = Awaited<ReturnType<IntelligenceService['getClientProfileV1']>>;
type RegulatoryLifecycle = Awaited<
  ReturnType<IntelligenceService['getClientRegulatoryProfile']>
>['regulatoryLifecycle'];
export type ProjectionPayload = Omit<Payload, 'sections'> & {
  sections: {
    snapshot: Omit<Payload['sections']['snapshot'], 'topAlerts'> & {
      topAlerts: Array<{
        id: string;
        type: string;
        severity: string;
        title: string;
        subtitle: string | null;
        when: string | null;
        countdownDays: number | null;
        countdownLabel: string | null;
        href: string;
        state: 'acknowledged' | null;
      }>;
      dailyBriefing: {
        summary: string;
        highlights: Array<{
          label: string;
          value: string | number | null;
          tone: 'critical' | 'notable' | 'info' | 'neutral';
        }>;
        generatedAt: string;
        eventCount: number;
        ctaHref: string;
      };
      health: Awaited<ReturnType<IntelligenceService['computeEngagementHealth']>> | null;
      trajectory: {
        label: string;
        growthRate: number | null;
        totalSpending: number;
        yearlySpend: unknown;
        model: { label: string; confidence: number | null; score: number | null; source: string };
        fallback: { label: string | null };
      };
    };
    financialFootprint: Payload['sections']['financialFootprint'] & {
      hero: {
        lobbyingTtm: number;
        obligationsTtm: number;
        returnRatio: number | null;
        gap: number;
        truthState: 'normal' | 'zero_obligation' | 'no_activity';
      };
      series: {
        lobbying: Array<{ year: number; amount: number }>;
        obligations: Array<{ year: number; amount: number }>;
        quarterSeries: Array<{ label: string; lobbying: number; obligations: number }>;
      };
      fecMoneyFlow: Awaited<ReturnType<IntelligenceService['getFecMoneyFlow']>>;
    };
    legislativeRegulatory: Omit<Payload['sections']['legislativeRegulatory'], 'kanban'> & {
      kanban: {
        total: number;
        issueCodes: string[];
        columns: Array<{
          id: 'introduced' | 'committee' | 'passed' | 'enacted';
          label: string;
          count: number;
          bills: Array<{
            identifier: string;
            title: string;
            latestActionDate: Date | null;
            latestActionText: string | null;
            probability: number;
            isManual: boolean;
          }>;
        }>;
      };
      regulatoryLifecycle: RegulatoryLifecycle;
    };
    relationships: Omit<Payload['sections']['relationships'], 'officeRecommender'> & {
      officeRecommender: OfficeRecommendation[];
      scopedGraph: {
        nodes: unknown[];
        edges: unknown[];
        resolutionQuality: {
          avgConfidence: number;
          confirmedCount: number;
          unconfirmedCount: number;
        };
        meta: { lobbyistCount: number; memberCount: number; committeeCount: number };
        hints: { exStafferNames: string[] };
      };
    };
  };
};

// The runtime API includes these spread fields; this erased view restores their
// types for tests without changing the production service's inferred surface.
export function projection(payload: Payload): ProjectionPayload {
  return payload as unknown as ProjectionPayload;
}

function regulation(documentNumber: string, overrides: Record<string, unknown> = {}) {
  return {
    documentNumber,
    title: `Rule ${documentNumber}`,
    type: 'PROPOSED_RULE',
    agencyNames: ['Science'],
    publicationDate: new Date('2026-10-01T00:00:00.000Z'),
    commentEndDate: new Date('2026-10-20T00:00:00.000Z'),
    effectiveDate: null,
    htmlUrl: `https://example.invalid/${documentNumber}`,
    ...overrides,
  };
}

export function districtRows() {
  const districts = [20, 0, 50, 10, 40, -1, 30, 60].map((totalAmount, index) => ({
    district: `VA-${index}`,
    totalAmount,
    awardCount: index,
    demographics: { dataYear: index === 7 ? '2026' : 'invalid' },
  }));
  return districts;
}

export function manualPinFixture() {
  const manual = trackedBill({
    identifier: '119-hr-manual',
    title: 'Small research bill',
    isManual: true,
  });
  const autos = Array.from({ length: 13 }, (_, index) =>
    trackedBill({
      identifier: `119-hr-auto-${index}`,
      title: 'National Defense Authorization Act',
    }),
  );
  const bills = [...autos, manual];
  return { manual, autos, bills };
}

export function stageBills() {
  const bills = [
    trackedBill({ identifier: 'intro' }),
    trackedBill({ identifier: 'committee', latestActionText: 'Referred to committee' }),
    trackedBill({ identifier: 'passed', status: 'passed_chamber' }),
    trackedBill({ identifier: 'law', actionTexts: ['Signed by the President'] }),
  ];
  return bills;
}

export function regulatoryFixtureOptions(): Options {
  const first = regulation('linked', {
    title: 'Original title',
    publicationDate: '2026-10-12',
    type: 'RULE',
    effectiveDate: '2026-10-12',
  });
  const independent = Array.from({ length: 9 }, (_, index) =>
    regulation(`independent-${index}`, {
      publicationDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    }),
  );
  return {
    sourceResults: {
      getBillRegulationLinks: {
        totalBills: 2,
        totalRegulations: 2,
        links: [
          { bill: { identifier: 'bill-a' }, regulations: [first] },
          { bill: { identifier: 'bill-b' }, regulations: [first] },
        ],
      },
      getClientRelevantRegulations: [
        regulation('linked', { title: 'Ignored duplicate' }),
        ...independent,
      ],
    },
  };
}

export function hearingFixtureOptions(): Options {
  const bills = [trackedBill(), trackedBill({ identifier: '119-s-7' })];
  return {
    sourceResults: { getTrackedBills: { total: 2, issueCodes: [], bills } },
    committeeRows: [{ committee_name: '  Science  ', committee_code: 'HSCI' }],
    rows: {
      hearings: [
        hearing({
          id: 'foreign',
          committeeName: 'Other',
          committeeCode: null,
          title: 'Other business',
        }),
        hearing({
          id: 'name',
          committeeName: 'House Committee on Science',
          committeeCode: null,
          title: 'Research',
          date: new Date('2026-10-15'),
        }),
        hearing({
          id: 'code',
          committeeName: 'Alias',
          committeeCode: 'hsci',
          title: 'Research',
          date: new Date('2026-10-13'),
        }),
        hearing({
          id: 'title',
          committeeName: 'Other',
          committeeCode: null,
          title: 'Consider H.R. 1234 and s7',
        }),
      ],
    },
  };
}

export function joinFailureFixtureOptions(): Options {
  return {
    sourceResults: { getTrackedBills: { total: 1, issueCodes: [], bills: [trackedBill()] } },
    committeeError: new Error('join unavailable'),
    rows: { hearings: [hearing(), hearing({ id: 'not-cited', title: 'Other topic' })] },
  };
}
