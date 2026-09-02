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

    it('uploads a file through the attachment store and registers it as campaign context', async () => {
      const { container } = renderStep();
      await screen.findByText('Your own documents');
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      // Wired now: enabled whenever the campaign has a sole client sponsor.
      expect(input.disabled).toBe(false);

      const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
      vi.stubGlobal('fetch', fetchMock);
      // `beforeEach` only mockClear()s, which does NOT undo an implementation
      // override — restore the hoisted default in finally or it leaks into
      // every later test in this file.
      const defaultPost = api.post.getMockImplementation();
      try {
        api.post.mockImplementation(async (url: string) => {
          if (url.includes('/attachments/upload-url')) {
            return { data: { url: 'https://s3.test/bucket', fields: { key: 'k1' }, s3Key: 's3-key-1' } };
          }
          if (url.includes('/attachments/confirm')) return { data: { id: 'att-new-1' } };
          if (url.includes('/context/memory/search')) return { data: { data: { candidates: state.memory } } };
          if (url.includes('/context/government/search')) return { data: { data: { candidates: state.government } } };
          return { data: {} };
        });

        const file = new File(['capability'], 'capability-statement.pdf', {
          type: 'application/pdf',
        });
        fireEvent.change(input, { target: { files: [file] } });

        await waitFor(() => expect(applyCommands).toHaveBeenCalled());
        // Presign carries the sponsor client; S3 got the actual bytes.
        expect(api.post).toHaveBeenCalledWith(
          '/api/engagement/attachments/upload-url',
          expect.objectContaining({ clientId: 'client-1', fileName: 'capability-statement.pdf' }),
        );
        expect(fetchMock).toHaveBeenCalledWith(
          'https://s3.test/bucket',
          expect.objectContaining({ method: 'POST' }),
        );
        // The CONFIRMED id — never the picked File — is what becomes context.
        const batch = applyCommands.mock.calls.at(-1)?.[0] as unknown as Array<{
          kind: string;
          payload: { selections?: Array<{ locator: Record<string, unknown> }> };
        }>;
        expect(batch[0]?.payload.selections?.[0]?.locator).toMatchObject({
          source: 'document',
          id: 'att-new-1',
          clientId: 'client-1',
        });
        expect(toast).toHaveBeenCalledWith('1 document added to this campaign’s context');
      } finally {
        if (defaultPost) api.post.mockImplementation(defaultPost);
        vi.unstubAllGlobals();
      }
    });

    it('keeps the upload leg disabled without a sole client sponsor — there is no library to store into', async () => {
      const { container } = renderStep({
        session: makeSession({ sponsor: { kind: 'none', label: '', clientRefs: [] } }),
      });
      await screen.findByText('Your own documents');
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.disabled).toBe(true);
      expect(
        screen.getByText(
          'Uploads become available once the campaign names a single client sponsor — the file is stored in that client’s documents.',
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

  describe('Request-a-meeting auto-attach (moved to the builder shell)', () => {
    // The auto-attach effect moved to `use-outreach-meeting-auto-context.ts`,
    // which runs at the builder SHELL on every step. What must still hold HERE
    // is the negative: the step itself no longer fetches capabilities or
    // auto-accepts anything — it only renders what is already on the spec.
    it('no longer auto-attaches from the step, even for a request-meeting campaign', async () => {
      state.capabilities = [{ id: 'cap-1' }];
      state.facilities = [{ id: 'fac-1' }];
      renderStep({ campaignType: 'request_meeting' }, makeSession());

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(applyCommands).not.toHaveBeenCalled();
      // And the endpoint the old effect fetched is no longer queried here.
      expect(api.get.mock.calls.filter(([url]) => String(url).includes('/capabilities'))).toHaveLength(0);
    });
  });
});
