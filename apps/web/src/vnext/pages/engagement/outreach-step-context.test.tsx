import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OutreachV3Command,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  outreachBuilderPrimaryLabel,
} from './outreach-campaign-flow.js';
import type { OutreachBuilderStepCommon } from './outreach-builder-model.js';
import {
  OUTREACH_CONTEXT_OPTION_SETS,
  OutreachContextStep,
  outreachContextOptionDefaults,
  outreachContextOptionsFromText,
  outreachContextOptionsGuidanceText,
} from './outreach-step-context.js';

/**
 * The Context step's central honesty property: every card is a real context
 * source with a real record count, and every switch is a real ACCEPT/EXCLUDE.
 * The prototype's six hard-coded cards ("4 records", "6 records") are exactly
 * what must NOT appear.
 */
const { api, state } = vi.hoisted(() => {
  const state: {
    memory: unknown[];
    government: unknown[];
    documents: unknown[];
    accepted: unknown;
    capabilities: unknown[];
    facilities: unknown[];
  } = { memory: [], government: [], documents: [], accepted: null, capabilities: [], facilities: [] };
  const api = {
    get: vi.fn(async (url: string) => {
      if (url.includes('/context/review')) return { data: { accepted: state.accepted } };
      if (url.includes('/context-library')) return { data: { documents: state.documents } };
      if (url.includes('/capabilities')) return { data: state.capabilities };
      if (url.includes('/facilities')) return { data: state.facilities };
      return { data: {} };
    }),
    post: vi.fn(async (url: string) => {
      if (url.includes('/context/memory/search')) {
        return { data: { data: { candidates: state.memory } } };
      }
      if (url.includes('/context/government/search')) {
        return { data: { data: { candidates: state.government } } };
      }
      return { data: {} };
    }),
  };
  return { api, state };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

const applyCommands = vi.fn(async (_commands: OutreachV3Command[]) => ({}));
const toast = vi.fn();
const onNext = vi.fn();

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
      goal: { goal: 'Send a client update', objective: 'Brief the office', topic: 'Ground robotics' },
      sponsor: { kind: 'client', label: 'Acme Robotics', clientRefs: [{ clientId: 'client-1' }] },
      targeting: { criteria: null, selectedTargetRefs: [] },
      delivery: { pattern: 'personalized_separate', personalization: 'high' },
      context,
      strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
      ...over,
    },
  } as unknown as OutreachV3SessionEnvelope;
}

function memoryCandidate(id: string, title: string, memoryType = 'firm_position') {
  return {
    title,
    summary: `${title} summary`,
    memoryType,
    clientId: 'client-1',
    verificationClass: 'first_party',
    sensitivity: 'normal',
    instructionsAllowed: false,
    lastVerifiedAt: '2026-08-01T00:00:00.000Z',
    selection: {
      locator: { source: 'memory', id },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    },
  };
}

function governmentCandidate(id: string, title: string, category = 'bill_action') {
  return {
    category,
    id,
    title,
    subtitle: null,
    date: '2026-07-04',
    href: null,
    selection: {
      locator: { source: 'government', id, category },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    },
  };
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

function renderStep(
  over: Partial<OutreachBuilderStepCommon> = {},
  envelope: OutreachV3SessionEnvelope = makeSession(),
  queryClient?: QueryClient,
) {
  state.accepted = envelope.spec.context;
  const props: OutreachBuilderStepCommon = {
    sessionId: 'session-1',
    session: envelope,
    campaignType: 'send_update',
    busy: false,
    applyCommands,
    toast,
    onNext,
    primaryLabel: outreachBuilderPrimaryLabel('context', 'send_update'),
    ...over,
  };
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div className="capiro-vnext-root">
        <OutreachContextStep {...props} />
      </div>
    </QueryClientProvider>,
  );
}

/** The six seeded update templates carry the options; this is the u4 set. */
function sessionWithTemplate(templateTitle = 'Hearings & markup week-ahead', extraRefs: unknown[] = []) {
  return makeSession({
    context: {
      ...emptyContext(),
      writingGuidanceRefs: [
        acceptedRef({
          contextKey: 'tpl-1',
          locator: { source: 'manual', id: 'tpl-1' },
          contextClass: 'writing_guidance',
          title: `Update template — ${templateTitle}`,
        }),
        ...extraRefs,
      ],
    },
  });
}

function lastCommands(): OutreachV3Command[] {
  return (applyCommands.mock.calls.at(-1)?.[0] ?? []) as OutreachV3Command[];
}

function commandOfType(type: string): OutreachV3Command | undefined {
  return lastCommands().find((command) => command.type === type);
}

describe('OutreachContextStep', () => {
  beforeEach(() => {
    state.memory = [];
    state.government = [];
    state.documents = [];
    state.accepted = null;
    state.capabilities = [];
    state.facilities = [];
    applyCommands.mockClear();
    toast.mockClear();
    onNext.mockClear();
    api.get.mockClear();
    api.post.mockClear();
  });

  it('carries the step title and subline the prototype promises', () => {
    expect(OUTREACH_BUILDER_STEP_TITLES.context).toBe('Choose the context Capiro may use');
    expect(OUTREACH_BUILDER_STEP_SUBLINES.context).toBe(
      'Only what you switch on can reach a draft. Recipient-specific context reaches that person and no one else.',
    );
  });

  it('advances with the prototype label and is never gated', async () => {
    renderStep();
    const next = await screen.findByRole('button', { name: 'Continue to review packet' });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  describe('source cards', () => {
    it('builds one card per real source, with the real record count', async () => {
      state.memory = [
        memoryCandidate('m1', 'Prior position on ground robotics'),
        memoryCandidate('m2', 'Approved capability language'),
      ];
      state.government = [governmentCandidate('g1', 'H.R. 4212 reported')];
      renderStep();

      const memoryCard = await screen.findByRole('button', { name: /Firm position/ });
      expect(within(memoryCard).getByText('2 notes')).toBeInTheDocument();
      expect(
        within(memoryCard).getByText(
          'Institutional memory · Prior position on ground robotics · Approved capability language',
        ),
      ).toBeInTheDocument();

      const governmentCard = screen.getByRole('button', { name: /Bill action/ });
      expect(within(governmentCard).getByText('1 record')).toBeInTheDocument();

      // The prototype's seeded counts must never appear.
      expect(screen.queryByText('4 records')).not.toBeInTheDocument();
      expect(screen.queryByText('6 records')).not.toBeInTheDocument();
      expect(screen.getByText('0 sources on · tailored to send update')).toBeInTheDocument();
    });

    it('switching a source on accepts exactly that group’s locators', async () => {
      state.memory = [
        memoryCandidate('m1', 'Prior position on ground robotics'),
        memoryCandidate('m2', 'Approved capability language'),
      ];
      state.government = [governmentCandidate('g1', 'H.R. 4212 reported')];
      renderStep();

      fireEvent.click(await screen.findByRole('button', { name: /Firm position/ }));
      await waitFor(() => expect(applyCommands).toHaveBeenCalled());

      const accept = commandOfType('ACCEPT_CONTEXT_REFS');
      expect(accept).toBeDefined();
      const payload = accept?.payload as { selections: Array<{ locator: { id: string } }> };
      expect(payload.selections.map((selection) => selection.locator.id)).toEqual(['m1', 'm2']);
    });

    it('switching an accepted source off excludes the refs it accepted', async () => {
      state.memory = [memoryCandidate('m1', 'Prior position on ground robotics')];
      const envelope = makeSession({
        context: { ...emptyContext(), campaignFactRefs: [acceptedRef()] },
      });
      renderStep({}, envelope);

      const card = await screen.findByRole('button', { name: /Firm position/ });
      await waitFor(() => expect(card).toHaveAttribute('aria-pressed', 'true'));
      expect(screen.getByText('1 source on · tailored to send update')).toBeInTheDocument();

      fireEvent.click(card);
      await waitFor(() => expect(applyCommands).toHaveBeenCalled());
      expect(commandOfType('EXCLUDE_CONTEXT_REFS')?.payload).toEqual({
        refs: [{ contextKey: 'ctx-1', reason: 'user_excluded' }],
      });
    });

    it('marks a target-scoped source as recipient-scoped', async () => {
      state.memory = [memoryCandidate('m1', 'Last meeting with the office')];
      const envelope = makeSession({
        context: {
          ...emptyContext(),
          targetSpecificRefs: [acceptedRef({ scope: { kind: 'target', targetKey: 't1' } })],
        },
      });
      renderStep({}, envelope);

      expect(await screen.findByText('Recipient-scoped')).toBeInTheDocument();
    });

    it('says why there are no sources rather than showing an empty grid', async () => {
      const envelope = makeSession({
        goal: { goal: '', objective: '', topic: '' },
      });
      renderStep({}, envelope);

      expect(
        await screen.findByText(
          'Capiro looks for context using the campaign name, and this campaign does not have one yet.',
        ),
      ).toBeInTheDocument();
      // No search can have run, so nothing may claim otherwise.
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  describe('per-template options', () => {
    it('shows the template’s fail-closed promise and its options instead of the source grid', async () => {
      renderStep({}, sessionWithTemplate());

      expect(await screen.findByText('Fails closed')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Never claims a stream is recordable. Live capability reads direct stream, browser, pending or unavailable — nothing else.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('10 options · Hearings & markup week-ahead')).toBeInTheDocument();
      expect(screen.getByText('Scope')).toBeInTheDocument();
      expect(screen.getByText('What counts as implicated')).toBeInTheDocument();
      const witnesses = screen.getByRole('switch', { name: 'Include witnesses' });
      expect(witnesses).toHaveAttribute('aria-checked', 'true');
      expect(witnesses).toHaveTextContent('On');
      // Options replace the generic grid, exactly as in the prototype.
      expect(screen.queryByText(/sources on ·/)).not.toBeInTheDocument();
    });

    it('writes the whole option set as one guidance ref and supersedes the previous one', async () => {
      const priorOptions = acceptedRef({
        contextKey: 'opt-prior',
        locator: { source: 'manual', id: 'opt-prior', text: '' },
        contextClass: 'writing_guidance',
        title: 'Campaign template options · Hearings & markup week-ahead',
      });
      renderStep({}, sessionWithTemplate('Hearings & markup week-ahead', [priorOptions]));

      const witnesses = await screen.findByRole('switch', { name: 'Include witnesses' });
      fireEvent.click(witnesses);
      await waitFor(() => expect(applyCommands).toHaveBeenCalled());

      const accept = commandOfType('ACCEPT_CONTEXT_REFS');
      const selection = (accept?.payload as { selections: Array<{ locator: { title: string; text: string } }> })
        .selections[0];
      expect(selection?.locator.title).toBe(
        'Campaign template options · Hearings & markup week-ahead',
      );
      expect(selection?.locator.text).toContain('Include witnesses: Off');
      expect(selection?.locator.text).toContain('Scope: Client portfolio');
      expect(commandOfType('EXCLUDE_CONTEXT_REFS')?.payload).toEqual({
        refs: [{ contextKey: 'opt-prior', reason: 'superseded' }],
      });
    });

    it('records a choice and a multi-select change in the same ref', async () => {
      renderStep({}, sessionWithTemplate());

      fireEvent.click(await screen.findByRole('button', { name: 'Firm-wide' }));
      await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
      let selection = (
        commandOfType('ACCEPT_CONTEXT_REFS')?.payload as {
          selections: Array<{ locator: { text: string } }>;
        }
      ).selections[0];
      expect(selection?.locator.text).toContain('Scope: Firm-wide');

      // 'House' starts selected, so clicking it removes it from the array.
      fireEvent.click(screen.getByRole('button', { name: 'House' }));
      await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(2));
      selection = (
        commandOfType('ACCEPT_CONTEXT_REFS')?.payload as {
          selections: Array<{ locator: { text: string } }>;
        }
      ).selections[0];
      expect(selection?.locator.text).toContain('Chambers: Senate');
    });

    it('round-trips every option kind through the guidance text, empty multi included', () => {
      const set = OUTREACH_CONTEXT_OPTION_SETS['hearings_week_ahead'];
      expect(set).toBeDefined();
      if (!set) return;
      const defaults = outreachContextOptionDefaults(set);
      const text = outreachContextOptionsGuidanceText(set, defaults, 'Hearings & markup week-ahead');
      expect(outreachContextOptionsFromText(set, text)).toEqual(defaults);

      const emptied = { ...defaults, chambers: [] as string[] };
      const emptiedText = outreachContextOptionsGuidanceText(set, emptied, 'x');
      expect(emptiedText).toContain('Chambers: (none)');
      expect(outreachContextOptionsFromText(set, emptiedText)['chambers']).toEqual([]);
    });
  });

  describe('your own documents', () => {
    it('states the isolation promise and the empty line', async () => {
      renderStep();
      expect(await screen.findByText('Your own documents')).toBeInTheDocument();
      expect(screen.getByText('Optional')).toBeInTheDocument();
      expect(
        screen.getByText(
          'Upload a capability statement, one-pager, mark table or memo and Capiro treats it as context for this campaign only. Nothing you upload is written to firm memory, and the file itself is never attached to an outgoing email.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Drop a file here or browse')).toBeInTheDocument();
      expect(screen.getByText('PDF, DOCX, XLSX or TXT · up to 25 MB each')).toBeInTheDocument();
      expect(
        screen.getByText('No documents added. The letter runs on the sources above.'),
      ).toBeInTheDocument();
    });

    it('never pretends a picked file was accepted — the upload leg is disabled', async () => {
      const { container } = renderStep();
      await screen.findByText('Your own documents');
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.disabled).toBe(true);
      expect(
        screen.getByText(
          'The context endpoint accepts an already-stored document id; there is no upload route for a campaign-scoped file.',
        ),
      ).toBeInTheDocument();
    });

    it('adds a document the firm has already stored', async () => {
      state.documents = [
        { id: 'doc-att-1', clientId: 'client-1', clientName: 'Acme Robotics', title: 'Capability statement', date: '2026-06-02' },
      ];
      renderStep();

      const select = (await screen.findByLabelText('Add a stored document')) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'att-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add document' }));
      await waitFor(() => expect(applyCommands).toHaveBeenCalled());

      const payload = commandOfType('ACCEPT_CONTEXT_REFS')?.payload as {
        selections: Array<{ locator: { source: string; id: string } }>;
      };
      expect(payload.selections[0]?.locator).toMatchObject({ source: 'document', id: 'att-1' });
      expect(toast).toHaveBeenCalledWith('1 document added to this campaign’s context');
    });

    it('lists an attached document with its real provenance and removes it', async () => {
      state.documents = [
        { id: 'doc-att-1', clientId: 'client-1', clientName: 'Acme Robotics', title: 'Capability statement', date: '2026-06-02' },
      ];
      const envelope = makeSession({
        context: {
          ...emptyContext(),
          campaignFactRefs: [
            acceptedRef({
              contextKey: 'ctx-doc',
              locator: { source: 'document', id: 'att-1' },
              title: 'Capability statement',
            }),
          ],
        },
      });
      renderStep({}, envelope);

      expect(await screen.findByText('Capability statement')).toBeInTheDocument();
      expect(screen.getByText('Campaign only')).toBeInTheDocument();
      expect(
        screen.queryByText('No documents added. The letter runs on the sources above.'),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Remove Capability statement' }));
      await waitFor(() => expect(applyCommands).toHaveBeenCalled());
      expect(commandOfType('EXCLUDE_CONTEXT_REFS')?.payload).toEqual({
        refs: [{ contextKey: 'ctx-doc', reason: 'user_excluded' }],
      });
    });

    it('explains why no stored document can be offered when the campaign has no single client', async () => {
      const envelope = makeSession({
        sponsor: { kind: 'firm', label: 'Capiro', clientRefs: [] },
      });
      renderStep({}, envelope);
      expect(
        await screen.findByText(
          'Stored documents become available once the campaign names a single client sponsor.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('Request-a-meeting auto-attached sponsor + target profile context', () => {
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

    it('attaches sponsor overview, each capability, each facility, and eligible targets’ career background', async () => {
      // Pre-seeded so capabilities/facilities are already in the cache on the
      // component's FIRST render — otherwise the sponsor record (derivable
      // synchronously) and the capability/facility pieces (which need their
      // own queries to resolve first) land in separate effect passes, and
      // since this test's `applyCommands` mock never feeds anything back into
      // `accepted`, a second pass would re-send the first pass's pieces too.
      // Pre-seeding collapses everything into one pass, matching what a real,
      // warm client cache gives a user revisiting this step.
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(['client-capabilities', 'client-1'], [{ id: 'cap-1' }, { id: 'cap-2' }]);
      queryClient.setQueryData(['client-facilities', 'client-1'], [{ id: 'fac-1' }]);
      renderStep({ campaignType: 'request_meeting' }, requestMeetingSession(), queryClient);

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
      renderStep({ campaignType: 'send_update' }, requestMeetingSession());

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
      renderStep({ campaignType: 'request_meeting' }, envelope);

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
        renderStep({ campaignType: 'request_meeting' }, requestMeetingSession(), queryClient);

        await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
        // Give the failed attempt's `pending` state time to settle back to
        // null and any effect re-run a chance to fire — this is exactly the
        // window the original bug looped in.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(applyCommands).toHaveBeenCalledTimes(1);
      } finally {
        applyCommands.mockImplementation(async () => ({}));
      }
    });
  });
});
