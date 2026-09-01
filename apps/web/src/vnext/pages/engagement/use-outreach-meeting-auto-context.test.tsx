import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  OutreachV3Command,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { useOutreachMeetingAutoContext } from './use-outreach-meeting-auto-context.js';

/**
 * The request-a-meeting auto-attach lives at the builder SHELL (moved out of
 * `outreach-step-context.tsx`), so these tests render the hook directly. The
 * behaviour under test is unchanged from when the effect lived in the step —
 * the tests moved with the logic, plus the shell wiring itself means the
 * effect no longer depends on the user visiting the Context step (asserted in
 * `outreach-step-context.test.tsx`'s "no longer auto-attaches" negative).
 */
const { api, state } = vi.hoisted(() => {
  const state: {
    capabilities: unknown[];
    facilities: unknown[];
  } = { capabilities: [], facilities: [] };
  const api = {
    get: vi.fn(async (url: string) => {
      if (url.includes('/capabilities')) return { data: state.capabilities };
      if (url.includes('/facilities')) return { data: state.facilities };
      return { data: {} };
    }),
  };
  return { api, state };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

const applyCommands = vi.fn(async (_commands: OutreachV3Command[]): Promise<void> => {});

function emptyContext() {
  return {
    requiredPolicyRefs: [],
    writingGuidanceRefs: [],
    campaignFactRefs: [],
    targetSpecificRefs: [],
    groupSafeRefs: [],
    excludedRefs: [],
  };
}

function makeSession(over: Record<string, unknown> = {}): OutreachV3SessionEnvelope {
  const context = { ...emptyContext(), ...((over['context'] as object) ?? {}) };
  return {
    session: { id: 'session-1' },
    currentStateVersion: 3,
    specHash: 'hash-1',
    readiness: { blockers: [] },
    pendingProposalCount: 0,
    spec: {
      // The hook derives the campaign type from the spec goal, so this must
      // read as a meeting request — not the step-test default update goal.
      goal: { goal: 'Request a meeting', objective: 'Brief the office', topic: 'Ground robotics' },
      sponsor: { kind: 'client', label: 'Acme Robotics', clientRefs: [{ clientId: 'client-1' }] },
      targeting: { criteria: null, selectedTargetRefs: [] },
      delivery: { pattern: 'personalized_separate', personalization: 'high' },
      context,
      strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
      ...over,
    },
  } as unknown as OutreachV3SessionEnvelope;
}

function acceptedRef(over: Record<string, unknown> = {}) {
  return {
    contextKey: 'ctx-1',
    locator: { source: 'memory', id: 'm1' },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
    title: 'Prior position on ground robotics',
    summary: 'Approved firm position.',
    verificationClass: 'first_party',
    sensitivity: 'normal',
    instructionsAllowed: false,
    usableAsEvidence: true,
    usableAsWritingGuidance: false,
    snapshotHash: 'snap-1',
    ...over,
  };
}

const memberTarget = {
  targetKey: 'directory_member:person-1',
  locator: { source: 'directory_member', id: 'person-1' },
  displayName: 'Rep. Jordan Smith',
  title: null,
  organization: null,
  email: 'jordan@house.gov',
  clientId: null,
  roleStatus: 'current',
  snapshotHash: 'hash-1',
  jurisdiction: {
    governmentLevel: 'federal',
    chamber: 'house',
    state: 'VA',
    district: '01',
    committees: [],
    issueAreas: [],
  },
};
// No career-background source exists for this target type at all — must
// never be attempted, or the server rejects the whole accept batch.
const legislatorTarget = {
  ...memberTarget,
  targetKey: 'state_legislator:sl-1',
  locator: { source: 'state_legislator', id: 'sl-1' },
  displayName: 'State Sen. Alex Rivera',
};

function requestMeetingSession(over: Record<string, unknown> = {}) {
  return makeSession({
    targeting: {
      criteria: null,
      selectedTargetRefs: [memberTarget, legislatorTarget],
      rejectedRecommendationRefs: [],
    },
    ...over,
  });
}

function renderHookWith(
  envelope: OutreachV3SessionEnvelope,
  queryClient: QueryClient,
): () => void {
  function Harness(): null {
    useOutreachMeetingAutoContext({
      session: envelope,
      applyCommands,
    });
    return null;
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return view.unmount;
}

describe('useOutreachMeetingAutoContext', () => {
  beforeEach(() => {
    applyCommands.mockClear();
    applyCommands.mockImplementation(async () => undefined);
    state.capabilities = [];
    state.facilities = [];
  });

  it('attaches sponsor overview, each capability, each facility, and eligible targets’ career background', async () => {
    // Pre-seeded so capabilities/facilities are already in the cache on the
    // FIRST render — otherwise the sponsor record (derivable synchronously)
    // and the capability/facility pieces (which need their own queries to
    // resolve first) land in separate effect passes, and since this test's
    // `applyCommands` mock never feeds anything back into `accepted`, a second
    // pass would re-send the first pass's pieces too. Pre-seeding collapses
    // everything into one pass, matching what a real, warm client cache gives
    // a user anywhere in the builder.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['client-capabilities', 'client-1'], [{ id: 'cap-1' }, { id: 'cap-2' }]);
    queryClient.setQueryData(['client-facilities', 'client-1'], [{ id: 'fac-1' }]);
    renderHookWith(requestMeetingSession(), queryClient);

    // The server's ACCEPT_CONTEXT_REFS is content-addressed and
    // deduplicates by contextKey (`normalizeResolvedContextRefsV1`), so a
    // second identical batch — possible here since this test's mocked
    // `applyCommands` never marks anything accepted, unlike the real
    // session-refetch that normally stops the effect — would be harmless
    // in production. Only the first call's completeness is asserted.
    await waitFor(() => expect(applyCommands).toHaveBeenCalled());
    const [commands] = applyCommands.mock.calls[0] as [OutreachV3Command[]];
    const accept = commands.find((command) => command.type === 'ACCEPT_CONTEXT_REFS');
    expect(accept).toBeDefined();
    const selections = (accept?.payload as { selections: Array<Record<string, unknown>> }).selections;
    const byRecordType = (recordType: string) =>
      selections.filter(
        (selection) => (selection.locator as Record<string, unknown>)['recordType'] === recordType,
      );

    expect(byRecordType('client')).toHaveLength(1);
    expect(byRecordType('client')[0]).toMatchObject({ locator: { id: 'client-1' } });
    expect(byRecordType('client_capability').map((s) => (s.locator as any).id).sort()).toEqual([
      'cap-1',
      'cap-2',
    ]);
    expect(byRecordType('client_facility').map((s) => (s.locator as any).id)).toEqual(['fac-1']);

    const careerBackground = selections.filter(
      (selection) => (selection.locator as Record<string, unknown>)['factCode'] === 'career_background',
    );
    expect(careerBackground).toHaveLength(1);
    expect(careerBackground[0]).toMatchObject({
      scope: { kind: 'target', targetKey: memberTarget.targetKey },
    });
  });

  it('never fires for send_update or custom campaigns', async () => {
    state.capabilities = [{ id: 'cap-1' }];
    state.facilities = [{ id: 'fac-1' }];
    renderHookWith(
      requestMeetingSession({
        goal: { goal: 'Send a client update', objective: 'Brief the office', topic: 'Ground robotics' },
      }),
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );

    // Give any stray effect a turn to run before asserting the negative.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(applyCommands).not.toHaveBeenCalled();
  });

  it('does not resend a piece that is already accepted', async () => {
    state.capabilities = [{ id: 'cap-1' }];
    state.facilities = [];
    const envelope = requestMeetingSession({
      context: {
        ...emptyContext(),
        campaignFactRefs: [
          acceptedRef({
            contextKey: 'ctx-client',
            locator: { source: 'capiro_record', recordType: 'client', id: 'client-1', clientId: 'client-1' },
            contextClass: 'campaign_fact',
          }),
          acceptedRef({
            contextKey: 'ctx-cap-1',
            locator: {
              source: 'capiro_record',
              recordType: 'client_capability',
              id: 'cap-1',
              clientId: 'client-1',
            },
            contextClass: 'campaign_fact',
          }),
        ],
        targetSpecificRefs: [
          acceptedRef({
            contextKey: 'ctx-career',
            locator: {
              source: 'target_profile_fact',
              targetRef: memberTarget.locator,
              factCode: 'career_background',
            },
            contextClass: 'target_specific',
            scope: { kind: 'target', targetKey: memberTarget.targetKey },
          }),
        ],
      },
    });
    renderHookWith(envelope, new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(applyCommands).not.toHaveBeenCalled();
  });

  it('retries the same missing set only once, even if the server keeps rejecting it', async () => {
    // Observed live: a deploy mismatch made the server reject this batch
    // every time. Nothing marked it accepted, so the original effect kept
    // re-firing as fast as React would allow — over 1,000 identical
    // requests hit the API before the tab was closed. This pins the fix:
    // one failed attempt at a given missing-set does not retry itself.
    state.capabilities = [{ id: 'cap-1' }];
    state.facilities = [];
    applyCommands.mockImplementation(async () => {
      throw new Error('OUTREACH_COMMAND_INVALID');
    });
    // Pre-seeded so capabilities are in the cache on the first render —
    // otherwise the sponsor record and the capability arrive in separate
    // effect passes, each a genuinely distinct missing-set that legitimately
    // gets its own single try. Collapsing to one pass keeps this test about
    // the one thing it's pinning: a given set is never retried twice.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['client-capabilities', 'client-1'], [{ id: 'cap-1' }]);
    queryClient.setQueryData(['client-facilities', 'client-1'], []);
    try {
      renderHookWith(requestMeetingSession(), queryClient);

      await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
      // Give the failed attempt's `pending` state time to settle back to
      // null and any effect re-run a chance to fire — this is exactly the
      // window the original bug looped in.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(applyCommands).toHaveBeenCalledTimes(1);
    } finally {
      applyCommands.mockImplementation(async () => undefined);
    }
  });
});
