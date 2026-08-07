import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { OpportunityRiskPanel } from './OpportunityRiskPanel.js';
import type { RiskContextView } from './funding-opportunities-api.js';

/**
 * The procurement risk panel (P45).
 *
 * Four rules carry it: nothing on it is legal advice, an active exclusion
 * routes to review rather than deciding, an expired or unverified exclusion is
 * visibly not an active one, and the absence caveat renders on every state
 * including the clean one.
 */

const CLIENT = '22222222-2222-2222-2222-222222222222';

const { apiGetMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  flags: { funding_opportunities_risk_context: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const CAVEATS = [
  'Absence of exclusion evidence is not evidence of good standing. Capiro reports only what the provider stated when it was last asked.',
  'A protest is context about a related procurement. It is not evidence that this procurement is invalid, that an agency erred, or that an award will change.',
  'Observations from MakeGov/Tango, with the provider’s own wording preserved.',
];

function payload(over: Partial<RiskContextView> = {}): RiskContextView {
  return {
    state: 'available',
    explanation: 'Procurement risk observations matched by exact UEI.',
    recommendationHint: null,
    exclusion: {
      state: 'none_observed',
      explanation:
        'Capiro has not observed an exclusion record for this client. This is not a clearance.',
      providerFlag: null,
      sourceUrl: null,
      observedAt: null,
      startDate: null,
      endDate: null,
    },
    protests: [],
    caveats: CAVEATS,
    asOf: '2026-09-03T12:00:00.000Z',
    ...over,
  };
}

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

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>{node}</AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  flags.funding_opportunities_risk_context = true;
});

describe('THE RULE: nothing on this panel is legal advice', () => {
  test('no advice-shaped phrase appears in any rendered state', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        recommendationHint: {
          state: 'needs_review',
          reason:
            'An active exclusion was observed against this client’s UEI. Blocked pending legal or compliance review.',
        },
        exclusion: {
          state: 'active',
          explanation: 'The provider reported an active exclusion against this UEI.',
          providerFlag: 'true',
          sourceUrl: 'https://sam.gov/exclusion/1',
          observedAt: '2026-09-01T00:00:00.000Z',
          startDate: null,
          endDate: null,
        },
        protests: [
          {
            caseNumber: 'B-421234.2',
            sourceSystem: 'gao',
            outcome: 'Sustained',
            outcomeCaveat: 'The provider’s own word for the docket state, unaltered.',
            caseType: 'protest',
            filedDate: '2026-04-01',
            decisionDate: '2026-07-15',
            agencyName: 'Department of the Navy',
            protesterName: 'Known Co',
            sourceUrl: 'https://gao.gov/products/b-421234.2',
            matchedOn: 'protester_uei',
          },
        ],
      }),
    });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    await screen.findByTestId('risk-hint');

    const text = (screen.getByTestId('fo-detail-risk').textContent ?? '').toLowerCase();
    for (const phrase of [
      'you should',
      'cannot bid',
      'is ineligible',
      'is disqualified',
      'is barred',
      'unlawful',
      'illegal',
      'liable',
    ]) {
      expect(text).not.toContain(phrase);
    }
  });

  test('an active exclusion ROUTES to review and names who decides', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        recommendationHint: {
          state: 'needs_review',
          reason:
            'An active exclusion was observed against this client’s UEI. Blocked pending legal or compliance review.',
        },
      }),
    });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    const hint = await screen.findByTestId('risk-hint');
    expect(hint.textContent).toContain('Needs review');
    expect(hint.textContent).toContain('pending legal or compliance review');
    // The panel offers no control that could resolve it here.
    expect(hint.querySelectorAll('button')).toHaveLength(0);
  });

  test('no hint renders when there is no active exclusion', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    await screen.findByTestId('risk-exclusion');
    expect(screen.queryByTestId('risk-hint')).toBeNull();
  });
});

describe('THE RULE: expired and unverified are visibly not active', () => {
  test.each([
    ['active', 'Exclusion observed — active'],
    ['expired', 'Exclusion observed — ended'],
    ['unverified', 'Exclusion observed — not re-checked recently'],
    ['none_observed', 'No exclusion observed'],
  ] as const)('%s renders its own label', async (state, label) => {
    apiGetMock.mockResolvedValue({
      data: payload({
        exclusion: {
          state,
          explanation: `state is ${state}`,
          providerFlag: 'true',
          sourceUrl: null,
          observedAt: '2026-06-01T00:00:00.000Z',
          startDate: null,
          endDate: null,
        },
      }),
    });
    const { unmount } = wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    const block = await screen.findByTestId('risk-exclusion');
    expect(block.textContent).toContain(label);
    // An expired or unverified state must never carry the active wording.
    if (state !== 'active') expect(block.textContent).not.toContain('— active');
    unmount();
  });
});

describe('THE RULE: an open protest is not a lost one', () => {
  test('a null outcome renders "Open or not stated"', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        protests: [
          {
            caseNumber: 'B-1',
            sourceSystem: 'cofc',
            outcome: null,
            outcomeCaveat: 'x',
            caseType: null,
            filedDate: '2026-04-01',
            decisionDate: null,
            agencyName: null,
            protesterName: null,
            sourceUrl: null,
            matchedOn: 'protester_uei',
          },
        ],
      }),
    });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    expect((await screen.findByTestId('protest-outcome-open')).textContent).toContain(
      'Open or not stated',
    );
    const text = screen.getByTestId('risk-protests').textContent ?? '';
    expect(text).not.toMatch(/denied|dismissed|failed/i);
    // The forum is carried, uppercased for display but not renamed.
    expect(text).toContain('COFC');
  });

  test('no protests says Capiro observed none, not that none exists', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    expect((await screen.findByTestId('risk-protests')).textContent).toContain(
      'not a statement that none exists',
    );
  });
});

describe('THE RULE: the absence caveat renders on every state', () => {
  test('including the clean one, where it matters most', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    expect((await screen.findByTestId('risk-caveats')).textContent).toContain(
      'not evidence of good standing',
    );
  });

  test('and beside an active finding', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        exclusion: {
          state: 'active',
          explanation: 'active',
          providerFlag: 'true',
          sourceUrl: null,
          observedAt: '2026-09-01T00:00:00.000Z',
          startDate: null,
          endDate: null,
        },
      }),
    });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    expect((await screen.findByTestId('risk-caveats')).textContent).toContain(
      'not evidence that this procurement is invalid',
    );
  });
});

describe('Honest states', () => {
  test('the flag off renders nothing and issues no request', () => {
    flags.funding_opportunities_risk_context = false;
    const { container } = wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    expect(container.querySelector('[data-testid="fo-detail-risk"]')).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('no client means no request', () => {
    wrap(<OpportunityRiskPanel clientId={null} />);
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(screen.getByText(/matched to a client’s own UEI/)).toBeTruthy();
  });

  test('a request failure is an error, not a clean record', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    expect((await screen.findByTestId('risk-error')).textContent).toContain(
      'Nothing can be concluded from it',
    );
  });

  test('the request goes to the client-keyed path', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityRiskPanel clientId={CLIENT} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(apiGetMock).toHaveBeenCalledWith(`/api/intelligence/clients/${CLIENT}/risk-context`);
  });
});
