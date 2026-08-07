import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { OpportunityCard } from './OpportunityCard.js';
import { SIGNAL_LABELS } from './opportunity-explanations.js';
import type { FundingOpportunity } from './funding-opportunities-api.js';

/**
 * P09 — the card explains itself in words.
 *
 * Before this, the card printed `{s.signal}: {s.matchedOn}` for every matched
 * signal and led with a bare `relevanceScore`. So `naicsExact` and `genericTopical`
 * appeared as identical-looking bullets, and a reader could not tell an exact
 * classification match from the word "defense" turning up in a DoD notice.
 *
 * The assertion that carries the phase: no raw camelCase key in the card's DEFAULT
 * text. The keys are still available, behind the evidence disclosure, for anyone
 * reconciling against the scorer.
 */

function opportunity(partial: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    id: 'sam_gov:notice-1',
    source: 'sam_gov',
    sourceRecordId: 'notice-1',
    sourceReference: 'N0001926R0001',
    sourceUrl: null,
    kind: 'solicitation',
    kindRaw: null,
    baseKind: null,
    title: 'Turbofan Engine Sustainment',
    agency: 'Department of the Navy',
    subAgency: null,
    office: null,
    status: 'active',
    postedDate: null,
    responseDeadline: '2027-01-15T00:00:00.000Z',
    responseDeadlineNote: null,
    closeOrArchiveDate: null,
    isActive: true,
    isPursuable: true,
    summary: null,
    summaryIsLink: false,
    naicsCodes: ['336411'],
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
    eligibility: { state: 'needs_review', reason: 'Set-aside not evaluated.' },
    matchedSignals: [],
    recommendation: null,
    acquisitionPosition: null,
    decision: null,
    missingProfileFields: [],
    sourceUpdatedAt: null,
    workflow: null,
    clientId: 'client-1',
    ...partial,
  };
}

function renderCard(o: FundingOpportunity) {
  return render(
    <AntApp>
      <OpportunityCard opportunity={o} clientId="client-1" />
    </AntApp>,
  );
}

/** Every camelCase signal key the scorers can emit. */
const RAW_KEYS = Object.keys(SIGNAL_LABELS);

describe('no raw machine key appears in the default card text', () => {
  test('an exact NAICS match reads as words, not as `naicsExact`', () => {
    renderCard(
      opportunity({
        matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' }],
      }),
    );
    expect(screen.getByText(/Exact NAICS match/)).toBeInTheDocument();
    // The key itself is not in the collapsed card.
    expect(screen.queryByText('naicsExact')).not.toBeInTheDocument();
  });

  test.each(RAW_KEYS)('the key %s never appears as visible text by default', (key) => {
    renderCard(
      opportunity({
        matchedSignals: [{ signal: key, strength: 'moderate', weight: 10, matchedOn: 'VALUE-1' }],
      }),
    );
    expect(screen.queryByText(key)).not.toBeInTheDocument();
  });

  test('the matched VALUE is shown, because the point of it is that it can be checked', () => {
    renderCard(
      opportunity({
        matchedSignals: [{ signal: 'agencyHistory', strength: 'strong', weight: 18, matchedOn: 'DEPT OF THE NAVY' }],
      }),
    );
    expect(screen.getByText(/DEPT OF THE NAVY/)).toBeInTheDocument();
  });
});

describe('the fit band replaces the bare relevance number in the headline', () => {
  test('a strong signal reads "Strong fit"', () => {
    renderCard(
      opportunity({
        matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' }],
      }),
    );
    expect(screen.getByText('Strong fit')).toBeInTheDocument();
    expect(screen.getByText('Fit')).toBeInTheDocument();
  });

  test('a weak generic token reads "Weak fit", never strong', () => {
    // "defense" in a DoD notice corpus is near-tautological. It must not be able to
    // present itself as a reason.
    renderCard(
      opportunity({
        relevanceScore: 91,
        matchedSignals: [{ signal: 'genericTopical', strength: 'weak', weight: 1, matchedOn: 'defense' }],
      }),
    );
    expect(screen.getByText('Weak fit')).toBeInTheDocument();
    expect(screen.queryByText('Strong fit')).not.toBeInTheDocument();
  });

  test('a high score with only weak signals is still a weak fit', () => {
    renderCard(
      opportunity({
        relevanceScore: 99,
        matchedSignals: [
          { signal: 'genericTopical', strength: 'weak', weight: 1, matchedOn: 'defense' },
          { signal: 'genericTopical', strength: 'weak', weight: 1, matchedOn: 'systems' },
          { signal: 'sector', strength: 'weak', weight: 4, matchedOn: 'DEFENSE' },
        ],
      }),
    );
    expect(screen.getByText('Weak fit')).toBeInTheDocument();
  });

  test('the numeric relevance is still available, behind the evidence disclosure', () => {
    // Kept deliberately: an operator auditing a match needs the number. It just
    // must not be what the card leads with.
    renderCard(
      opportunity({
        relevanceScore: 62,
        matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' }],
      }),
    );
    expect(screen.getByText(/relevance 62/)).toBeInTheDocument();
  });
});

describe('a thin profile stays honest', () => {
  test('no signals means no leading reason and no invented one', () => {
    renderCard(opportunity({ matchedSignals: [], relevanceScore: 0 }));
    expect(screen.queryByText(/Strongest reason/)).not.toBeInTheDocument();
    // And it does NOT claim an absence as a finding.
    expect(screen.queryByText(/no prior/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });

  test('with no signals the fit is weak, not blank', () => {
    renderCard(opportunity({ matchedSignals: [] }));
    expect(screen.getByText('Weak fit')).toBeInTheDocument();
  });
});

describe('screen readers can tell the three concepts apart', () => {
  test('fit, eligibility and workflow are separately labelled', () => {
    // The specific confusion this prevents: three coloured tags in a row that all
    // read as just their own text, so a screen reader announces "Strong fit, Needs
    // review, Saved" with no indication of which axis each belongs to.
    renderCard(
      opportunity({
        matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' }],
        workflow: {
          id: 'wf-1',
          status: 'saved',
          owner: null,
          facility: null,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: true,
          staleAt: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    );
    expect(screen.getByLabelText('Fit: Strong fit')).toBeInTheDocument();
    // Eligibility and workflow keep their own visible labels.
    expect(screen.getByText('Eligibility')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});

// ── P23: the concise acquisition-position badge ─────────────────────────────

describe('the acquisition-position badge is concise: present only when there is something to say', () => {
  test('no badge at all when acquisitionPosition is null', () => {
    renderCard(opportunity({ acquisitionPosition: null }));
    expect(screen.queryByText('Vehicle access')).not.toBeInTheDocument();
  });

  test('a direct position renders its own label', () => {
    renderCard(
      opportunity({
        acquisitionPosition: {
          state: 'direct_prime_access',
          evidence: [],
          summary: 'This client holds a live position on Test GWAC.',
          recommendedRoute: 'Bid directly under Test GWAC.',
          source: 'tango',
          freshness: { lastSyncedAt: '2026-08-01T00:00:00.000Z', neverSynced: false },
        },
      }),
    );
    expect(screen.getByText('Vehicle access')).toBeInTheDocument();
    expect(screen.getByText('Direct prime access')).toBeInTheDocument();
  });

  test('a related-entity position never renders with the same text as direct access', () => {
    renderCard(
      opportunity({
        acquisitionPosition: {
          state: 'related_entity_access',
          evidence: [],
          summary: 'A related entity holds a live position.',
          recommendedRoute: 'Route through the related entity.',
          source: 'tango',
          freshness: { lastSyncedAt: '2026-08-01T00:00:00.000Z', neverSynced: false },
        },
      }),
    );
    expect(screen.getByText('Related-entity access')).toBeInTheDocument();
    expect(screen.queryByText('Direct prime access')).not.toBeInTheDocument();
  });
});
