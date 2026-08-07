import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { App as AntApp } from 'antd';
import {
  DetailSectionBoundary,
  OpportunityAssessmentPanel,
} from './OpportunityAssessmentPanel.js';
import {
  MACHINE_RECOMMENDATIONS,
  RECOMMENDATION_COLORS,
  RECOMMENDATION_LABELS,
  type FundingOpportunity,
} from './funding-opportunities-api.js';

/**
 * The assessment drawer's isolation and parity (P32).
 *
 * Two properties carry the phase. A section that throws must not blank the
 * assessment — enforced by a boundary per section rather than by hoping nothing
 * throws. And a recommendation must read the same wherever it is rendered —
 * enforced by there being exactly one place that maps a value to a label.
 */

const HERE = __dirname;

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function opportunity(partial: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    id: 'sam_gov:notice-1',
    source: 'sam_gov',
    sourceRecordId: 'notice-1',
    sourceReference: null,
    sourceUrl: null,
    kind: 'solicitation',
    kindRaw: null,
    baseKind: null,
    recommendation: {
      machineRecommendation: 'needs_review',
      recommendationConfidence: 'medium',
      primaryReason: 'Strong capability match with unresolved eligibility.',
      primaryRisk: 'Set-aside eligibility has not been determined.',
      recommendedNextAction: 'Confirm the small-business size standard for NAICS 336412.',
      reasonCodes: ['exact_industry_match'],
    },
    acquisitionPosition: null,
    decision: null,
    title: 'Turbofan Engine Sustainment',
    agency: 'Department of the Army',
    subAgency: null,
    office: null,
    status: 'active',
    postedDate: null,
    responseDeadline: null,
    responseDeadlineNote: null,
    closeOrArchiveDate: null,
    isActive: true,
    isPursuable: true,
    summary: null,
    summaryIsLink: false,
    naicsCodes: [],
    pscCodes: [],
    setAside: null,
    setAsideCode: null,
    eligibleApplicantTypes: [],
    assistanceListings: [],
    fundingInstrument: null,
    category: null,
    grantFunding: null,
    contractValue: { estimatedValue: null, basis: 'not_stated_by_source' },
    placeOfPerformance: null,
    districtKey: null,
    districtBasis: null,
    relevanceScore: 62,
    eligibility: { state: 'unknown', reason: 'Not evaluated.' },
    matchedSignals: [],
    missingProfileFields: [],
    sourceUpdatedAt: null,
    workflow: null,
    clientId: 'client-1',
    ...partial,
  };
}

function wrap(node: React.ReactNode) {
  return render(<AntApp>{node}</AntApp>);
}

function Boom(): never {
  throw new Error('synthetic section failure');
}

beforeEach(() => {
  setupBrowserMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('one section failing does not blank the assessment', () => {
  test('a throwing section is replaced by a NAMED failure card', async () => {
    wrap(
      <DetailSectionBoundary title="Notice history" testId="fo-timeline">
        <Boom />
      </DetailSectionBoundary>,
    );
    const failure = await screen.findByTestId('fo-timeline-failed');
    // The reader learns WHICH section failed, and that it is a rendering
    // failure rather than a finding about the opportunity.
    expect(failure).toHaveTextContent('Notice history could not be displayed');
    expect(failure).toHaveTextContent(/rendering failure, not a finding/i);
  });

  test('a SECONDARY failure says the rest of the assessment still stands', async () => {
    wrap(
      <DetailSectionBoundary title="Requirements" testId="fo-detail-requirements">
        <Boom />
      </DetailSectionBoundary>,
    );
    expect(await screen.findByTestId('fo-detail-requirements-failed')).toHaveTextContent(
      /the rest of the assessment below is unaffected/i,
    );
  });

  test('a PRIMARY failure does not claim the rest is fine', async () => {
    wrap(
      <DetailSectionBoundary title="Executive assessment" testId="fo-detail-assessment" primary>
        <Boom />
      </DetailSectionBoundary>,
    );
    const failure = await screen.findByTestId('fo-detail-assessment-failed');
    expect(failure).toHaveTextContent(/No conclusion about this opportunity follows/i);
    expect(failure.textContent ?? '').not.toMatch(/rest of the assessment below is unaffected/i);
  });

  test('SIBLING sections still render when one throws', async () => {
    // The acceptance line, directly: one secondary section does not blank the
    // assessment.
    wrap(
      <>
        <DetailSectionBoundary title="Notice history" testId="fo-timeline">
          <Boom />
        </DetailSectionBoundary>
        <OpportunityAssessmentPanel opportunity={opportunity()} unscored={false} />
      </>,
    );
    expect(await screen.findByTestId('fo-timeline-failed')).toBeTruthy();
    expect(screen.getByTestId('fo-detail-assessment')).toHaveTextContent('Needs review');
  });

  test('a healthy section renders its children untouched', () => {
    wrap(
      <DetailSectionBoundary title="Requirements" testId="fo-detail-requirements">
        <div data-testid="child">intact</div>
      </DetailSectionBoundary>,
    );
    expect(screen.getByTestId('child')).toHaveTextContent('intact');
    expect(screen.queryByTestId('fo-detail-requirements-failed')).toBeNull();
  });

  test('no stack trace or component stack reaches the page', async () => {
    // A stack tells a reader nothing and may quote source content the
    // surrounding phases treat as untrusted.
    const { container } = wrap(
      <DetailSectionBoundary title="Requirements" testId="fo-detail-requirements">
        <Boom />
      </DetailSectionBoundary>,
    );
    await screen.findByTestId('fo-detail-requirements-failed');
    expect(container.textContent ?? '').not.toMatch(/synthetic section failure/);
    expect(container.textContent ?? '').not.toMatch(/at Boom|componentStack/);
  });
});

describe('an absent recommendation is absent, never a pass', () => {
  test('the unscored read says WHY it is not calculated', () => {
    wrap(
      <OpportunityAssessmentPanel
        opportunity={opportunity({ recommendation: null })}
        unscored
      />,
    );
    const section = screen.getByTestId('fo-detail-assessment');
    expect(section).toHaveTextContent(/Not calculated without a client/i);
    expect(section.textContent ?? '').not.toMatch(/\bPass\b/);
  });

  test('a scored record with no recommendation says so, and rules out "pass"', () => {
    // Two different causes, two different sentences, and neither is a
    // recommendation.
    wrap(
      <OpportunityAssessmentPanel
        opportunity={opportunity({ recommendation: null })}
        unscored={false}
      />,
    );
    expect(screen.getByTestId('fo-detail-assessment')).toHaveTextContent(
      /absence of a recommendation, not a recommendation to pass/i,
    );
  });

  test('a null risk renders as "no specific risk", never as blank', () => {
    wrap(
      <OpportunityAssessmentPanel
        opportunity={opportunity({
          recommendation: { ...opportunity().recommendation!, primaryRisk: null },
        })}
        unscored={false}
      />,
    );
    expect(screen.getByTestId('fo-detail-assessment')).toHaveTextContent(
      'No specific risk identified.',
    );
  });

  test('confidence is labelled as evidence quality, never as a percentage', () => {
    wrap(<OpportunityAssessmentPanel opportunity={opportunity()} unscored={false} />);
    const section = screen.getByTestId('fo-detail-assessment');
    expect(section).toHaveTextContent('Confidence: medium');
    expect(section.textContent ?? '').not.toMatch(/\d+%/);
  });

  test('every recommendation value renders with its own label', () => {
    for (const value of MACHINE_RECOMMENDATIONS) {
      const view = wrap(
        <OpportunityAssessmentPanel
          opportunity={opportunity({
            recommendation: { ...opportunity().recommendation!, machineRecommendation: value },
          })}
          unscored={false}
        />,
      );
      expect(screen.getByTestId('fo-detail-recommendation').textContent).toBe(
        RECOMMENDATION_LABELS[value],
      );
      view.unmount();
    }
  });
});

describe('the recommendation reads the same wherever it is rendered', () => {
  test('every value in the vocabulary has a label AND a colour', () => {
    for (const value of MACHINE_RECOMMENDATIONS) {
      expect(RECOMMENDATION_LABELS[value]).toBeTruthy();
      expect(RECOMMENDATION_COLORS[value]).toBeTruthy();
    }
  });

  test('exactly ONE file in this surface maps a machine recommendation to a label', () => {
    // The parity guarantee, made structural. The card and the detail composed
    // these independently before, which is how a card can say "Pursue" while
    // the drawer says "Needs review" about the same row. One table, one
    // renderer, no drift possible.
    const owners = readdirSync(HERE)
      .filter((f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && !f.includes('.test.'))
      .filter((f) => {
        const body = readFileSync(join(HERE, f), 'utf8');
        // A local map from the four recommendation values to display strings.
        return /RECOMMENDATION_LABELS[^=]*=\s*\{/.test(body) && !/import/.test(body.split('RECOMMENDATION_LABELS')[0]!.slice(-40));
      });
    expect(owners).toEqual(['funding-opportunities-api.ts']);
  });

  test('no component declares its own recommendation label map', () => {
    for (const file of readdirSync(HERE).filter(
      (f) => f.endsWith('.tsx') && !f.includes('.test.'),
    )) {
      const body = readFileSync(join(HERE, file), 'utf8');
      expect(body).not.toMatch(/const RECOMMENDATION_LABELS/);
      expect(body).not.toMatch(/const RECOMMENDATION_COLORS/);
    }
  });
});

describe('every detail section is independently isolated', () => {
  const detail = readFileSync(join(HERE, 'FundingOpportunityDetail.tsx'), 'utf8');

  test('there is no single boundary around the whole drawer', () => {
    // One boundary at the top would satisfy React and defeat the purpose: the
    // first throw would still blank everything.
    const boundaries = detail.match(/<DetailSectionBoundary/g) ?? [];
    expect(boundaries.length).toBeGreaterThanOrEqual(4);
  });

  test('the primary flag is on the executive assessment and nothing else', () => {
    const primary = detail.match(/<DetailSectionBoundary[^>]*primary/g) ?? [];
    expect(primary).toHaveLength(1);
    expect(primary[0]).toContain('fo-detail-assessment');
  });

  test('the assessment section is rendered by the shared panel, not inline', () => {
    expect(detail).toMatch(/<OpportunityAssessmentPanel/);
    // The old inline block declared its own colour map; it is gone.
    expect(detail).not.toMatch(/RECOMMENDATION_COLORS\[o\.recommendation/);
  });
});
