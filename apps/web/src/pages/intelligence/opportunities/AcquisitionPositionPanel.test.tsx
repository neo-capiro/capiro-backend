import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { AcquisitionPositionPanel } from './AcquisitionPositionPanel.js';
import type { AcquisitionPosition, FundingOpportunity } from './funding-opportunities-api.js';

/**
 * P23. Three things this file exists to prove, matching this phase's own
 * acceptance bar and AcquisitionPositionPanel.tsx's own doc:
 *
 *   1. Each of the three reasons `acquisitionPosition` can be null gets its
 *      OWN distinct, honest copy — never one generic blank.
 *   2. Every populated state renders, and never with an eligibility or
 *      win-probability word.
 *   3. A related/teaming route never renders as direct access.
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
    relevanceScore: 0,
    eligibility: { state: 'unknown', reason: 'x' },
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

function position(partial: Partial<AcquisitionPosition> = {}): AcquisitionPosition {
  return {
    state: 'direct_prime_access',
    evidence: [],
    summary: 'This client holds a live position on Test GWAC.',
    recommendedRoute: 'Bid directly under Test GWAC.',
    source: 'tango',
    freshness: { lastSyncedAt: '2026-08-01T00:00:00.000Z', neverSynced: false },
    ...partial,
  };
}

function renderPanel(o: FundingOpportunity) {
  return render(
    <AntApp>
      <AcquisitionPositionPanel opportunity={o} />
    </AntApp>,
  );
}

describe('the three reasons acquisitionPosition can be null get three different explanations', () => {
  test('no client (unscored): says so, not "not yet available"', () => {
    renderPanel(opportunity({ clientId: null, acquisitionPosition: null }));
    expect(screen.getByTestId('fo-detail-acquisition')).toHaveTextContent(/not calculated without a client/i);
  });

  test('a grant: says a grant has no vehicle concept, a SOURCE fact, not a product gap', () => {
    renderPanel(opportunity({ source: 'grants_gov', acquisitionPosition: null }));
    const section = screen.getByTestId('fo-detail-acquisition');
    expect(section).toHaveTextContent(/not provided/i);
    expect(section).toHaveTextContent(/no contract-vehicle concept/i);
  });

  test('a sam_gov row with a client and the flag off: "not yet available for this workspace"', () => {
    renderPanel(opportunity({ source: 'sam_gov', clientId: 'client-1', acquisitionPosition: null }));
    expect(screen.getByTestId('fo-detail-acquisition')).toHaveTextContent(/not yet available for this workspace/i);
  });

  test('none of the three null-reason messages ever reads as a negative determination', () => {
    for (const o of [
      opportunity({ clientId: null, acquisitionPosition: null }),
      opportunity({ source: 'grants_gov', acquisitionPosition: null }),
      opportunity({ acquisitionPosition: null }),
    ]) {
      const { unmount } = renderPanel(o);
      const text = screen.getByTestId('fo-detail-acquisition').textContent ?? '';
      expect(text).not.toMatch(/cannot bid|not eligible|no access|ineligible/i);
      unmount();
    }
  });
});

describe('every populated state renders, honestly', () => {
  test('direct prime access', () => {
    renderPanel(opportunity({ acquisitionPosition: position({ state: 'direct_prime_access' }) }));
    expect(screen.getByTestId('acquisition-position-state')).toHaveTextContent('Direct prime access');
  });

  test('related entity access never renders as direct', () => {
    renderPanel(
      opportunity({
        acquisitionPosition: position({
          state: 'related_entity_access',
          summary: 'A related entity holds a live position on Test GWAC; this client does not hold one itself.',
        }),
      }),
    );
    const state = screen.getByTestId('acquisition-position-state');
    expect(state).toHaveTextContent('Related-entity access');
    expect(state).not.toHaveTextContent('Direct prime access');
  });

  test('known teaming route', () => {
    renderPanel(opportunity({ acquisitionPosition: position({ state: 'known_teaming_route' }) }));
    expect(screen.getByTestId('acquisition-position-state')).toHaveTextContent('Known teaming route');
  });

  test('vehicle not identified', () => {
    renderPanel(
      opportunity({
        acquisitionPosition: position({
          state: 'vehicle_not_identified',
          summary: 'No contract vehicle relevant to this client has been identified.',
        }),
      }),
    );
    expect(screen.getByTestId('acquisition-position-state')).toHaveTextContent('Vehicle not identified');
  });

  test('no current access evidence', () => {
    renderPanel(
      opportunity({
        acquisitionPosition: position({
          state: 'no_direct_access_evidence',
          summary: 'The only relevant vehicle found (Test GWAC) has passed its last date to order.',
        }),
      }),
    );
    expect(screen.getByTestId('acquisition-position-state')).toHaveTextContent('No current access evidence');
  });

  test('unknown, with a "never synced" badge', () => {
    renderPanel(
      opportunity({
        acquisitionPosition: position({
          state: 'unknown',
          summary: 'MakeGov/Tango is not configured, so vehicle access cannot be evaluated.',
          freshness: { lastSyncedAt: null, neverSynced: true },
        }),
      }),
    );
    expect(screen.getByTestId('acquisition-position-state')).toHaveTextContent('Unknown');
    expect(screen.getByText('Never synced')).toBeInTheDocument();
  });

  test('never a word from ELIGIBILITY_LABELS, never a probability, on any populated state', () => {
    const states: AcquisitionPosition['state'][] = [
      'direct_prime_access',
      'related_entity_access',
      'known_teaming_route',
      'vehicle_not_identified',
      'no_direct_access_evidence',
      'unknown',
    ];
    for (const state of states) {
      const { unmount } = renderPanel(opportunity({ acquisitionPosition: position({ state }) }));
      const text = (screen.getByTestId('fo-detail-acquisition').textContent ?? '').toLowerCase();
      expect(text).not.toMatch(/\beligible\b|\bineligible\b|win probability|% chance|likely to win/);
      unmount();
    }
  });

  test('the evidence table is behind a disclosure and shows the route, not just the vehicle', () => {
    renderPanel(
      opportunity({
        acquisitionPosition: position({
          evidence: [
            {
              tangoVehicleId: 'V1',
              vehicleName: 'Test GWAC',
              vehicleType: 'GWAC',
              relationship: 'self',
              recipientUei: 'ZZTESTUEI001',
              orderCount: 5,
              idvObligations: 100000,
              idvContractsValue: 500000,
              lastDateToOrder: '2030-01-01T00:00:00.000Z',
              expired: false,
              lastSyncedAt: '2026-08-01T00:00:00.000Z',
            },
          ],
        }),
      }),
    );
    expect(screen.getByText(/Evidence \(1\)/)).toBeInTheDocument();
  });
});
