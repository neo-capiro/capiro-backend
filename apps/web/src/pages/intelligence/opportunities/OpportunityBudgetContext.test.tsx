import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { OpportunityBudgetContext } from './OpportunityBudgetContext.js';
import { BUDGET_BETA_LABEL, type BudgetContextView } from './funding-opportunities-api.js';

/**
 * The budget beta panel (P44).
 *
 * Four rules carry it:
 *   1. Federal-account execution is visibly NOT Program Element funding.
 *   2. "No account is linked to this notice" renders above the data, always.
 *   3. A null figure renders "Not stated" — never $0, never a bare dash.
 *   4. The provider's own attribution confidence is on screen, in the
 *      provider's own words.
 */

const CLIENT = '22222222-2222-2222-2222-222222222222';

const { apiGetMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  flags: { funding_opportunities_budget_context: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const LINKAGE =
  'No federal account is linked to this notice. SAM.gov notices carry no Treasury account symbol, and matching on agency name would be a guess.';
const GRAIN =
  'Federal account × fiscal year. This is appropriation-container execution, not Program Element line-item funding — the two are different grains and are never compared here.';

function payload(over: Partial<BudgetContextView> = {}): BudgetContextView {
  return {
    state: 'available',
    explanation: 'Federal-account execution for accounts that obligated contract dollars.',
    source: BUDGET_BETA_LABEL,
    noticeLinkage: { linked: false, explanation: LINKAGE },
    grain: GRAIN,
    fiscalYears: [
      {
        fiscalYear: 2026,
        accounts: [
          {
            federalAccountSymbol: '097-0400',
            fiscalYear: 2026,
            accountTitle: 'Operation and Maintenance, Defense-Wide',
            agencyName: 'Department of Defense',
            bureauName: 'Defense-Wide',
            money: {
              requestedBa: null,
              enactedBa: null,
              apportioned: null,
              // The live-observed shape: one figure present, the rest null.
              obligatedTotal: null,
              outlayedTotal: null,
              unobligatedBalance: null,
              contractObligated: '123456789.12',
            },
            attributionStatus: 'partial',
            attributionConfidence: 'medium',
            clientFlow: {
              recipientUei: 'ABC123DEF456',
              contractObligated: '1250000.00',
              contractOutlayed: null,
              contractCount: 3,
              fundingOfficeName: 'NAVSEA Philadelphia',
              fundingAgencyName: 'Department of the Navy',
            },
            lastSyncedAt: '2026-08-30T00:00:00.000Z',
          },
        ],
      },
    ],
    asOf: '2026-09-01T12:00:00.000Z',
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
  flags.funding_opportunities_budget_context = true;
});

describe('THE RULE: federal-account execution is not Program Element funding', () => {
  test('the grain is stated, and "Program Element" appears only in the sentence denying it', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);

    const grain = await screen.findByTestId('budget-grain');
    expect(grain.textContent).toContain('Federal account × fiscal year');
    expect(grain.textContent).toContain('not Program Element line-item funding');

    // Every mention of Program Element on the panel is inside that denial. A
    // reader must not find the phrase anywhere it could read as a comparison.
    const panel = screen.getByTestId('fo-detail-budget-context');
    const mentions = (panel.textContent ?? '').split('Program Element').length - 1;
    expect(mentions).toBe(1);
  });

  test('the card title and the source line both carry the beta label', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    await screen.findByTestId('budget-grain');
    expect(screen.getByTestId('fo-detail-budget-context').textContent).toContain(
      BUDGET_BETA_LABEL,
    );
    expect((await screen.findByTestId('budget-source')).textContent).toContain(
      'the provider labels it beta',
    );
  });

  test('each fiscal year is its own group — no figure spans two years', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        fiscalYears: [
          { fiscalYear: 2026, accounts: payload().fiscalYears[0]!.accounts },
          { fiscalYear: 2025, accounts: payload().fiscalYears[0]!.accounts },
        ],
      }),
    });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    expect(await screen.findByTestId('budget-fy-2026')).toBeTruthy();
    expect(screen.getByTestId('budget-fy-2025')).toBeTruthy();
    // No combined total anywhere.
    const text = screen.getByTestId('fo-detail-budget-context').textContent ?? '';
    expect(text).not.toMatch(/total across/i);
    expect(text).not.toMatch(/combined/i);
  });
});

describe('THE RULE: the linkage disclaimer renders above the data, always', () => {
  test('it is present when there IS data', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    expect((await screen.findByTestId('budget-notice-linkage')).textContent).toContain(
      'No federal account is linked to this notice',
    );
  });

  test.each([
    ['not_synced', 'Capiro has not synchronized federal budget accounts yet.'],
    ['no_flows', 'No federal account shows contract obligations to this client’s UEI.'],
    ['no_client_identity', 'This client has no recorded UEI.'],
  ] as const)('it is present on the %s empty state too', async (state, explanation) => {
    apiGetMock.mockResolvedValue({
      data: payload({ state, explanation, fiscalYears: [] }),
    });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    expect((await screen.findByTestId('budget-notice-linkage')).textContent).toContain(
      'No federal account is linked to this notice',
    );
    expect(screen.getByTestId('budget-empty').textContent).toContain(explanation);
  });
});

describe('THE RULE: a null figure renders "Not stated", never $0', () => {
  test('the six null money fields never render as zero', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    await screen.findByTestId('budget-fy-2026');

    const text = screen.getByTestId('fo-detail-budget-context').textContent ?? '';
    expect(text).toContain('Not stated');
    expect(text).not.toContain('$0');
    expect(text).not.toContain('$0.00');
  });

  test('a present figure is grouped from its exact decimal string, cents intact', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    await screen.findByTestId('budget-fy-2026');
    // 1250000.00 → $1,250,000.00, formatted from the string rather than
    // through a float that could lose the cents.
    expect(screen.getByText('$1,250,000.00')).toBeTruthy();
  });
});

describe('THE RULE: the provider’s own confidence is on screen', () => {
  test('status and confidence render verbatim', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    const cell = await screen.findByTestId('budget-attribution');
    expect(cell.textContent).toContain('partial');
    expect(cell.textContent).toContain('medium');
  });

  test('an account with no stated confidence says so rather than looking confident', async () => {
    const base = payload();
    base.fiscalYears[0]!.accounts[0]!.attributionStatus = null;
    base.fiscalYears[0]!.accounts[0]!.attributionConfidence = null;
    apiGetMock.mockResolvedValue({ data: base });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    expect((await screen.findByTestId('budget-attribution')).textContent).toContain('Not stated');
  });
});

describe('Honest states', () => {
  test('the flag off renders nothing at all — not an empty card', () => {
    flags.funding_opportunities_budget_context = false;
    const { container } = wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    expect(container.querySelector('[data-testid="fo-detail-budget-context"]')).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('no client means no request, and the copy says why', () => {
    wrap(<OpportunityBudgetContext clientId={null} />);
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(screen.getByText(/matched to a client’s own UEI/)).toBeTruthy();
  });

  test('a request failure is an error, never an empty panel', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    const alert = await screen.findByTestId('budget-error');
    expect(alert.textContent).toContain('not a finding about the client’s federal funding');
  });

  test('the request goes to the client-keyed path', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(<OpportunityBudgetContext clientId={CLIENT} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/intelligence/clients/${CLIENT}/budget-context`,
    );
  });
});
