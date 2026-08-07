import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { OpportunityActionPlan } from './OpportunityActionPlan.js';
import {
  isActionRecorded,
  type ActionPlanResultView,
  type ProposedActionView,
} from './funding-opportunities-api.js';

/**
 * The action plan panel (P34).
 *
 * Three rules carry it: a proposal is visibly not a commitment, accepting one
 * goes through P08's server action and nowhere else, and nothing is invented
 * where the server named nothing.
 */

const { apiGetMock, apiPostMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  flags: { funding_opportunities_government_landscape: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const SAM_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';

function action(over: Partial<ProposedActionView> = {}): ProposedActionView {
  return {
    id: 'act-1',
    category: 'qualify',
    title: 'Make the bid/no-bid decision',
    rationale: 'A solicitation has a fixed close, so the decision has to be made early.',
    intent: 'pursuit',
    evidence: [],
    suggestedTarget: null,
    dueDateBasis: '21 days before the stated response deadline (bid/no-bid decision)',
    dueDate: '2026-09-10T17:00:00.000Z',
    unresolvedPrerequisites: [],
    ...over,
  };
}

function payload(over: Partial<ActionPlanResultView> = {}): ActionPlanResultView {
  return {
    state: 'available',
    explanation: 'Proposed actions only. Nothing here is committed until somebody accepts it.',
    plan: {
      source: 'sam_gov',
      sourceRecordId: SAM_ID,
      clientId: CLIENT,
      stage: 'solicitation',
      actions: [action()],
      fingerprint: 'abc123',
      generatedAt: '2026-08-07T12:00:00.000Z',
    },
    acceptance: {
      wired: true,
      explanation: 'Accepting an action creates or reuses the matching task.',
    },
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

function panel(over: Record<string, unknown> = {}) {
  return (
    <OpportunityActionPlan
      clientId={CLIENT}
      source="sam_gov"
      sourceRecordId={SAM_ID}
      workflowStatus={null}
      {...over}
    />
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  flags.funding_opportunities_government_landscape = true;
});

describe('THE RULE: a proposal is visibly not a commitment', () => {
  test('an unaccepted action is labelled Proposed and offers an Accept control', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await screen.findByTestId('fo-plan-action-act-1');
    expect(screen.getByTestId('fo-plan-proposed-act-1')).toHaveTextContent('Proposed');
    expect(screen.getByTestId('fo-plan-accept-act-1')).toBeEnabled();
    expect(screen.queryByTestId('fo-plan-recorded-act-1')).toBeNull();
  });

  test('the panel says nothing has happened yet', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    const { container } = wrap(panel());
    await screen.findByTestId('fo-plan-action-act-1');
    expect(container.textContent ?? '').toMatch(/Nothing here is recorded until you accept it/i);
  });

  test('an action the workflow already carries is Recorded, and cannot be re-accepted', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(panel({ workflowStatus: 'pursuing' }));
    await screen.findByTestId('fo-plan-action-act-1');
    expect(screen.getByTestId('fo-plan-recorded-act-1')).toHaveTextContent('Recorded');
    expect(screen.getByTestId('fo-plan-accept-act-1')).toBeDisabled();
  });

  test('"recorded" tracks the intent, not the row', () => {
    // Saving an opportunity records the REVIEW decision and not the pursuit, so
    // a saved row must still offer the pursuit proposal.
    expect(isActionRecorded('review', 'saved')).toBe(true);
    expect(isActionRecorded('pursuit', 'saved')).toBe(false);
    expect(isActionRecorded('pursuit', 'pursuing')).toBe(true);
    expect(isActionRecorded('review', 'suggested')).toBe(false);
    // A note creates nothing, so it can never be recorded.
    expect(isActionRecorded('none', 'pursuing')).toBe(false);
    expect(isActionRecorded('review', null)).toBe(false);
  });

  test('a reference action offers no Accept control at all', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        plan: {
          ...payload().plan!,
          stage: 'closed_or_informational',
          actions: [action({ id: 'act-ref', category: 'reference', intent: 'none' })],
        },
      }),
    });
    const { container } = wrap(panel());
    await screen.findByTestId('fo-plan-action-act-ref');
    expect(screen.queryByTestId('fo-plan-accept-act-ref')).toBeNull();
    expect(container.textContent ?? '').toMatch(/this is a note, not a task/i);
  });
});

describe('THE RULE: accepting goes through P08 and nowhere else', () => {
  test('Accept posts the intent to the idempotent server action', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    apiPostMock.mockResolvedValue({ data: {} });
    wrap(panel());
    await screen.findByTestId('fo-plan-action-act-1');
    fireEvent.click(screen.getByTestId('fo-plan-accept-act-1'));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    const [url, body] = apiPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(
      `/api/intelligence/clients/${CLIENT}/opportunities/sam_gov/${SAM_ID}/action`,
    );
    expect(body.intent).toBe('pursuit');
    // The proposal's own words travel with the task, so the task says what it is
    // for rather than only which opportunity it came from.
    expect(body.nextAction).toBe('Make the bid/no-bid decision');
  });

  test('states that a second acceptance of the same kind reuses the task', async () => {
    // P08 keys its task per intent. A user who expected three tasks and found
    // one should have been told, not left to discover it.
    apiGetMock.mockResolvedValue({ data: payload() });
    wrap(panel());
    await screen.findByTestId('fo-plan-idempotency-note');
    expect(screen.getByTestId('fo-plan-idempotency-note')).toHaveTextContent(
      /updates the existing task rather than opening another one/i,
    );
  });

  test('offers no Accept when the server says acceptance is not wired', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        acceptance: {
          wired: false,
          explanation: 'Accepting an action is not wired for agency forecasts yet.',
        },
        plan: { ...payload().plan!, stage: 'forecast', actions: [action({ intent: 'review' })] },
      }),
    });
    wrap(panel({ source: 'agency_forecast' }));
    await screen.findByTestId('fo-plan-action-act-1');
    expect(screen.queryByTestId('fo-plan-accept-act-1')).toBeNull();
    expect(screen.getByTestId('fo-plan-acceptance-unwired')).toHaveTextContent(
      /not wired for agency forecasts/i,
    );
  });

  test('a refused acceptance says what the server said, and that nothing was created', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    apiPostMock.mockRejectedValue({
      response: { data: { message: 'This contract opportunity is closed.' } },
    });
    const { container } = wrap(panel());
    await screen.findByTestId('fo-plan-action-act-1');
    fireEvent.click(screen.getByTestId('fo-plan-accept-act-1'));
    await waitFor(() =>
      expect(container.ownerDocument.body.textContent ?? '').toMatch(
        /This contract opportunity is closed\..*Nothing was created/s,
      ),
    );
  });
});

describe('THE RULE: nothing is invented where the server named nothing', () => {
  test('renders no target line when the server supplied none', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    const { container } = wrap(panel());
    await screen.findByTestId('fo-plan-action-act-1');
    expect(screen.queryByTestId('fo-plan-target-act-1')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/your contact|reach out to/i);
  });

  test('renders a target verbatim when the server derived one', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        plan: {
          ...payload().plan!,
          actions: [
            action({
              suggestedTarget: 'Programme office for 0204163N',
              evidence: [
                { source: 'program_element', sourceId: 'm-1', matchedOn: '0204163N' },
              ],
            }),
          ],
        },
      }),
    });
    wrap(panel());
    const target = await screen.findByTestId('fo-plan-target-act-1');
    expect(target).toHaveTextContent('Programme office for 0204163N');
    // The evidence is shown alongside, so the target is checkable rather than
    // asserted.
    expect(screen.getByTestId('fo-plan-action-act-1')).toHaveTextContent('Program Element — 0204163N');
  });

  test('shows a due date only with the basis it was derived from', async () => {
    apiGetMock.mockResolvedValue({ data: payload() });
    const row = await (async () => {
      wrap(panel());
      return screen.findByTestId('fo-plan-action-act-1');
    })();
    expect(row).toHaveTextContent(/21 days before the stated response deadline/);
  });

  test('renders no date at all when the server derived none', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        plan: {
          ...payload().plan!,
          actions: [action({ dueDate: null, dueDateBasis: null })],
        },
      }),
    });
    const row = await (async () => {
      wrap(panel());
      return screen.findByTestId('fo-plan-action-act-1');
    })();
    expect(row).not.toHaveTextContent(/Suggested by/);
  });

  test('shows an unmet prerequisite on the proposal, before it is accepted', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({
        plan: {
          ...payload().plan!,
          actions: [
            action({
              intent: 'review',
              title: 'Build the compliance matrix',
              unresolvedPrerequisites: [
                'No requirements have been extracted from this solicitation’s documents yet.',
              ],
            }),
          ],
        },
      }),
    });
    wrap(panel());
    const blocked = await screen.findByTestId('fo-plan-blocked-act-1');
    expect(blocked).toHaveTextContent(/No requirements have been extracted/);
    // Still acceptable — an unmet prerequisite is information, not a lock. The
    // team may well decide the first step IS extracting them.
    expect(screen.getByTestId('fo-plan-accept-act-1')).toBeEnabled();
  });

  test('a denied plan names no stage and shows no actions', async () => {
    apiGetMock.mockResolvedValue({
      data: payload({ state: 'denied', explanation: 'Not available for this client.', plan: null }),
    });
    wrap(panel());
    const note = await screen.findByTestId('fo-plan-no-plan');
    expect(note).toHaveTextContent('Not available for this client.');
    expect(screen.queryByTestId('fo-plan-action-act-1')).toBeNull();
  });
});

describe('the panel refuses to imply anything when it cannot answer', () => {
  test('a request failure is not an absence of work', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    wrap(panel());
    const error = await screen.findByTestId('fo-plan-error');
    expect(error).toHaveTextContent(/request failure, not an absence of work/i);
  });

  test('the flag being off says nothing about the opportunity', async () => {
    flags.funding_opportunities_government_landscape = false;
    wrap(panel());
    expect(await screen.findByTestId('fo-plan-not-enabled')).toHaveTextContent(
      /says nothing about what should be done/i,
    );
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('no client means no plan, and says why', async () => {
    wrap(panel({ clientId: null }));
    expect(await screen.findByTestId('fo-plan-unscored')).toHaveTextContent(
      /depends on the client, not on the notice/i,
    );
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('an unsupported source is refused rather than shown empty', async () => {
    wrap(panel({ source: 'grants_gov' }));
    expect(await screen.findByTestId('fo-plan-unsupported')).toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});
