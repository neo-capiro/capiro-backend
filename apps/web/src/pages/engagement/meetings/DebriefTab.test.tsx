// QA gap coverage, same rationale as NotesTab.test.tsx's own header comment:
// DebriefTab is ALWAYS mocked wholesale in MeetingDetailPanel.test.tsx (repo
// convention), so it had no direct test file of its own. Written for the
// meeting-drawer navy reskin phase, which added the top-of-tab stage pill,
// the closing rule-reinforcement sentence, a real "restricted" panel (was a
// plain text line), and interactive (session-local) action-item checkboxes —
// real, new behavior that deserves real coverage against the actual
// component, not just via a mock.
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { DebriefTab } from './DebriefTab.js';
import {
  MeetingPanelChromeProvider,
  type MeetingPanelChrome,
} from './meeting-panel-chrome.js';
import type {
  Meeting,
  MeetingDebrief,
  MeetingDebriefDraft,
} from './meetings-types.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: apiPatchMock,
    delete: vi.fn(),
  }),
}));

/** Routes the shared apiGetMock by URL — DebriefTab always fires BOTH
 *  useMeetingDebriefs (/debriefs) and useMeetingNotes (/notes) on mount, so a
 *  single blanket mockResolvedValue can't give each its own fixture. */
function mockGetResponses(responses: { debriefs?: MeetingDebrief[]; notes?: unknown[] }) {
  apiGetMock.mockImplementation((url: string) => {
    if (url.includes('/debriefs')) return Promise.resolve({ data: responses.debriefs ?? [] });
    if (url.includes('/notes')) return Promise.resolve({ data: responses.notes ?? [] });
    return Promise.resolve({ data: [] });
  });
}

function makeDebrief(overrides: Partial<MeetingDebrief> = {}): MeetingDebrief {
  return {
    id: 'd1',
    confidential: true,
    status: 'generated',
    sharedAt: null,
    sharedByUserId: null,
    authorUserId: null,
    author: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
    body: 'Recap\nDiscussed the FY27 markup schedule.\n\nAction Items\n- Send the follow-up memo\n- Schedule the staffer call\n\nNotes\nStaffer flagged a scheduling conflict.',
    restricted: false,
    ...overrides,
  };
}

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm1',
    subject: 'Budget sync',
    source: 'outlook',
    description: null,
    location: null,
    // Ended in the past by default, so most fixtures land unlocked without
    // each test having to restate it.
    startsAt: '2020-01-01T14:00:00.000Z',
    endsAt: '2020-01-01T14:30:00.000Z',
    organizerEmail: null,
    organizerName: null,
    status: 'confirmed',
    metadata: null,
    isVirtual: false,
    joinLink: null,
    provider: null,
    visibility: 'private',
    sharedAt: null,
    sharedByUserId: null,
    client: null,
    attendees: [],
    attachments: [],
    preps: [],
    notes: [],
    debriefs: [],
    notesApproved: false,
    meri: 'done',
    contributors: [],
    sharedBy: null,
    ...overrides,
  } as Meeting;
}

/** A generated draft exactly as useGenerateDebriefDraft's POST returns. */
function makeDraft(overrides: Partial<MeetingDebriefDraft> = {}): MeetingDebriefDraft {
  return {
    recap: 'The chairman agreed to move NDAA markup to the first week of October.',
    actionItems: ['Circulate the revised authorization text', 'Confirm the floor vote window'],
    notes: 'Committee staff flagged the sequencing risk with the CR.',
    provider: 'openai',
    model: 'gpt-4.1',
    ...overrides,
  };
}

/** chrome spy the new draft-and-save tests can assert toasts on (the real
 *  FALLBACK_CHROME silently drops them, which would make "toast shown"
 *  assertions impossible). */
function chromeSpy(): MeetingPanelChrome & { calls: Array<[kind: string, text: string]> } {
  const calls: Array<[kind: string, text: string]> = [];
  return {
    calls,
    confirm: () => {},
    success: (text) => calls.push(['success', text]),
    error: (text) => calls.push(['error', text]),
    warning: (text) => calls.push(['warning', text]),
  };
}

function buildTree(qc: QueryClient, props: Parameters<typeof DebriefTab>[0]): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <DebriefTab {...props} />
      </AntApp>
    </QueryClientProvider>
  );
}

function buildTreeWithChrome(
  qc: QueryClient,
  chrome: MeetingPanelChrome,
  props: Parameters<typeof DebriefTab>[0],
): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <MeetingPanelChromeProvider chrome={chrome}>
          <DebriefTab {...props} />
        </MeetingPanelChromeProvider>
      </AntApp>
    </QueryClientProvider>
  );
}

describe('DebriefTab', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
  });

  test('an unfinished meeting shows the "Locked" stage pill and the locked panel', async () => {
    mockGetResponses({});
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({
          startsAt: '2099-01-01T10:00:00.000Z',
          endsAt: '2099-01-01T10:30:00.000Z',
          meri: null,
        }),
      }),
    );
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Debrief locked')).toBeInTheDocument();
  });

  test.each(['cancelled', 'canceled'])('a %s meeting does not offer debrief generation', async (status) => {
    mockGetResponses({ debriefs: [], notes: [] });
    render(buildTree(new QueryClient(), { meeting: makeMeeting({ status }) }));
    expect(await screen.findByText('Meeting cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Not started')).not.toBeInTheDocument();
    expect(screen.queryByText(/choose a source for this meeting/i)).not.toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  test('cancellation preserves a saved debrief while removing regeneration', async () => {
    mockGetResponses({ debriefs: [makeDebrief()], notes: [] });
    render(buildTree(new QueryClient(), { meeting: makeMeeting({ status: 'cancelled', endsAt: '2099-01-01T10:30:00Z', meri: null }) }));
    expect(await screen.findByText('Discussed the FY27 markup schedule.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export/i })).toBeEnabled();
  });

  test('no debrief yet (unlocked) shows the "Not started" stage pill and the source picker', async () => {
    mockGetResponses({ debriefs: [], notes: [] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() => expect(screen.getByText('Not started')).toBeInTheDocument());
    expect(screen.getByText(/choose a source for this meeting's debrief/i)).toBeInTheDocument();
  });

  test('a restricted debrief (private to another author) shows a real blocked panel, not a plain text line', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ restricted: true, body: null })] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() => expect(screen.getByText('Restricted')).toBeInTheDocument());
    expect(screen.getByText('A private debrief by another author exists')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The record is visible but its body is not exposed. Your own debrief is authored separately from the same meeting.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('This debrief is private to its author.')).toBeNull();
  });

  test('an approved debrief shows the "Approved" stage pill and its recap/action items', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ status: 'approved' })] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() =>
      expect(screen.getByText('Discussed the FY27 markup schedule.')).toBeInTheDocument(),
    );
    // Two distinct navy "Approved" signals now coexist by design: the top
    // stage pill and ArtifactActionBar's own approved chip.
    expect(screen.getAllByText('Approved').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Send the follow-up memo')).toBeInTheDocument();
  });

  test('a generated (not yet approved) debrief shows the "Draft" stage pill', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ status: 'generated' })] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() => expect(screen.getByText('Draft')).toBeInTheDocument());
  });

  test('a populated debrief body ends with the rule-reinforcement sentence', async () => {
    mockGetResponses({ debriefs: [makeDebrief()] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));
    await waitFor(() =>
      expect(
        screen.getByText('Approval unlocks explicit sharing; export remains available either way.'),
      ).toBeInTheDocument(),
    );
  });

  test('action items are interactive checkboxes: clicking toggles a line-through and it is NOT persisted to the server', async () => {
    mockGetResponses({ debriefs: [makeDebrief()] });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting() }));

    const item = await screen.findByText('Send the follow-up memo');
    const checkbox = screen.getAllByRole('checkbox')[0]!;
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveStyle({ textDecoration: 'none' });

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');
    expect(item).toHaveStyle({ textDecoration: 'line-through' });
    // Session-local only — no PATCH/POST fired for the toggle itself.
    expect(apiPatchMock).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(screen.getByText(/checking items off is for this session only/i)).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'false');
    expect(item).toHaveStyle({ textDecoration: 'none' });
  });

  test('clicking Approve on a generated debrief POSTs the approve mutation with the exact meeting/debrief ids', async () => {
    mockGetResponses({ debriefs: [makeDebrief({ id: 'd77', status: 'generated' })] });
    apiPostMock.mockResolvedValue({ data: { id: 'd77', status: 'approved' } });
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting({ id: 'm99' }) }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/engagement/meetings/m99/debriefs/d77/approve',
      ),
    );
  });

  describe('draft-and-save — one-click "Generate Debrief"', () => {
    /** Stateful GET/POST pair that models the honest server round-trip: the
     *  save POST persists the exact body it was given and the debriefs GET
     *  returns that same persisted artifact back — the tab then has to make
     *  it visible through the real invalidation/refetch path, not through any
     *  test-side cache seeding. */
    function wireRoundTrip(meetingId: string) {
      let saved: MeetingDebrief | null = null;
      apiGetMock.mockImplementation((url: string) => {
        if (url.includes('/debriefs')) return Promise.resolve({ data: saved ? [saved] : [] });
        if (url.includes('/notes')) return Promise.resolve({ data: [] });
        return Promise.resolve({ data: [] });
      });
      apiPostMock.mockImplementation((url: string, body?: unknown) => {
        if (url === `/api/engagement/meetings/${meetingId}/debrief-draft`) {
          return Promise.resolve({ data: makeDraft() });
        }
        if (url === `/api/engagement/meetings/${meetingId}/debriefs`) {
          saved = makeDebrief({ id: 'd-saved', status: 'generated', body: (body as { body: string }).body });
          return Promise.resolve({ data: saved });
        }
        return Promise.resolve({ data: {} });
      });
      return () => saved;
    }

    async function pickManualSourceAndClickGenerate(sourceText: string) {
      // SourcePicker defaults to 'upload' when there are no Meri notes; pick
      // the manual card, type real source text, then click the real button.
      fireEvent.click(screen.getByRole('button', { name: /type notes manually/i }));
      fireEvent.change(screen.getByPlaceholderText(/capture outcomes/i), {
        target: { value: sourceText },
      });
      fireEvent.click(screen.getByRole('button', { name: /generate debrief/i }));
    }

    test('generates via the debrief-draft endpoint, saves the formatted artifact, and renders the SAVED debrief visibly', async () => {
      const sourceText = 'Chairman wants markup moved to the first week of October. Staff flagged CR sequencing risk.';
      const meeting = makeMeeting({ id: 'm7' });
      const getSaved = wireRoundTrip('m7');
      const chrome = chromeSpy();
      render(buildTreeWithChrome(new QueryClient(), chrome, { meeting }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /generate debrief/i })).toBeInTheDocument(),
      );
      await pickManualSourceAndClickGenerate(sourceText);

      // 1. Generation POST: the exact endpoint + payload, carrying the
      //    90s-capable server route this whole fix exists to protect.
      await waitFor(() =>
        expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meetings/m7/debrief-draft', {
          method: 'manual',
          sourceText,
        }),
      );
      // 2. Save POST: the formatted draft body from formatDebriefBody — the
      //    draft's recap and action items are persisted verbatim.
      await waitFor(() =>
        expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meetings/m7/debriefs', {
          body: expect.stringContaining('The chairman agreed to move NDAA markup to the first week of October.'),
        }),
      );
      const saveCall = apiPostMock.mock.calls.find(
        (c) => c[0] === '/api/engagement/meetings/m7/debriefs',
      )!;
      expect(saveCall[1]).toMatchObject({
        body: expect.stringContaining('- Circulate the revised authorization text'),
      });
      // 3. Order: generate FIRST, then save — never the reverse.
      const genIdx = apiPostMock.mock.calls.findIndex(
        (c) => c[0] === '/api/engagement/meetings/m7/debrief-draft',
      );
      expect(genIdx).toBeLessThan(apiPostMock.mock.calls.indexOf(saveCall));
      // 4. The honest artifact: what the save POST persisted is exactly what
      //    the GET served back and what is now visibly rendered.
      const persisted = getSaved();
      expect(persisted?.body).toBe(saveCall[1]!.body);
      expect(
        await screen.findByText('The chairman agreed to move NDAA markup to the first week of October.'),
      ).toBeInTheDocument();
      expect(screen.getByText('Circulate the revised authorization text')).toBeInTheDocument();
      expect(screen.getByText('Committee staff flagged the sequencing risk with the CR.')).toBeInTheDocument();
      expect(screen.getByText('Draft')).toBeInTheDocument();
      // 5. The success toast fired and the picker is gone.
      expect(chrome.calls).toContainEqual(['success', 'Debrief drafted.']);
      expect(screen.queryByRole('button', { name: /generate debrief/i })).not.toBeInTheDocument();
    });

    test('a failed generation shows the real error and never fires the save POST', async () => {
      mockGetResponses({ debriefs: [], notes: [] });
      apiPostMock.mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'));
      const chrome = chromeSpy();
      render(buildTreeWithChrome(new QueryClient(), chrome, { meeting: makeMeeting({ id: 'm8' }) }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /generate debrief/i })).toBeInTheDocument(),
      );
      await pickManualSourceAndClickGenerate('Markup slips to October; confirm the floor vote window.');

      // The exact generation route was hit once, the save route never.
      await waitFor(() =>
        expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meetings/m8/debrief-draft', {
          method: 'manual',
          sourceText: 'Markup slips to October; confirm the floor vote window.',
        }),
      );
      expect(apiPostMock).toHaveBeenCalledTimes(1);
      expect(apiPostMock).not.toHaveBeenCalledWith('/api/engagement/meetings/m8/debriefs', expect.anything());
      // The failure surfaced through the panel chrome (toast), matching the
      // catch that prevents the fire-and-forget caller swallowing it silently.
      await waitFor(() => expect(chrome.calls).toContainEqual(['error', 'timeout of 30000ms exceeded']));
      // The picker returns so the user can retry — no stuck busy state.
      expect(await screen.findByRole('button', { name: /generate debrief/i })).toBeInTheDocument();
      expect(screen.queryByText(/Meri is drafting the debrief/i)).not.toBeInTheDocument();
    });

    test('while generation is in flight the pending state takes over and blocks a second attempt', async () => {
      let resolveGeneration: (value: { data: MeetingDebriefDraft }) => void = () => {};
      mockGetResponses({ debriefs: [], notes: [] });
      apiPostMock.mockImplementation(
        (url: string) =>
          url.includes('/debrief-draft')
            ? new Promise<{ data: MeetingDebriefDraft }>((resolve) => {
                resolveGeneration = resolve;
              })
            : Promise.resolve({ data: {} }),
      );
      render(buildTree(new QueryClient(), { meeting: makeMeeting({ id: 'm9' }) }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: /generate debrief/i })).toBeInTheDocument(),
      );
      await pickManualSourceAndClickGenerate('Source text for a hanging generation.');

      // The pending control state replaces the picker entirely: the
      // GeneratingState copy shows and there is no second clickable
      // "Generate Debrief" while the POST is in flight.
      expect(await screen.findByText(/Meri is drafting the debrief/i)).toBeInTheDocument();
      expect(screen.getByText('Generating')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /generate debrief/i })).not.toBeInTheDocument();
      // Exactly one POST so far — the hanging generation itself. No save,
      // no second attempt while the picker is replaced by the pending state.
      expect(apiPostMock).toHaveBeenCalledTimes(1);
      expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meetings/m9/debrief-draft', {
        method: 'manual',
        sourceText: 'Source text for a hanging generation.',
      });

      // Un-hang and let the whole chain settle: the save POST fires and the
      // (still-open) debriefs query refetches, so no pending mutation or
      // dangling React update is left behind after the test.
      resolveGeneration({ data: makeDraft() });
      await waitFor(() =>
        expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meetings/m9/debriefs', {
          body: expect.stringContaining('The chairman agreed to move NDAA markup to the first week of October.'),
        }),
      );
      await waitFor(() =>
        expect(screen.queryByText(/Meri is drafting the debrief/i)).not.toBeInTheDocument(),
      );
    });
  });

  describe('EM-09 — attachment approval (Transcript & attachments)', () => {
    function makeAttachment(overrides: Partial<Meeting['attachments'][number]> = {}) {
      return {
        id: 'att-1',
        meetingId: 'm1',
        fileName: 'meeting-transcript-2026-09-08.txt',
        contentType: 'text/plain',
        byteSize: 4096,
        source: 'upload',
        createdAt: '2026-09-08T00:00:00Z',
        approvedAt: null,
        approvedByUserId: null,
        sharedAt: null,
        sharedByUserId: null,
        ...overrides,
      };
    }

    test('an unapproved attachment shows its filename and a real, working Approve control', async () => {
      mockGetResponses({ debriefs: [], notes: [] });
      const qc = new QueryClient();
      render(
        buildTree(qc, {
          meeting: makeMeeting({ attachments: [makeAttachment()] }),
        }),
      );
      expect(
        await screen.findByText('meeting-transcript-2026-09-08.txt'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
      expect(screen.queryByText('Approved')).not.toBeInTheDocument();
    });

    test('clicking Approve on an attachment POSTs the real attachment-approve endpoint with exact ids', async () => {
      mockGetResponses({ debriefs: [], notes: [] });
      apiPostMock.mockResolvedValue({ data: makeMeeting() });
      const qc = new QueryClient();
      render(
        buildTree(qc, {
          meeting: makeMeeting({
            id: 'm42',
            attachments: [makeAttachment({ id: 'att-9' })],
          }),
        }),
      );

      const approveButton = await screen.findByRole('button', { name: /^approve$/i });
      fireEvent.click(approveButton);

      await waitFor(() =>
        expect(apiPostMock).toHaveBeenCalledWith(
          '/api/engagement/meetings/m42/attachments/att-9/approve',
        ),
      );
    });

    test('an already-approved attachment shows "Approved" instead of an Approve button', async () => {
      mockGetResponses({ debriefs: [], notes: [] });
      const qc = new QueryClient();
      render(
        buildTree(qc, {
          meeting: makeMeeting({
            attachments: [makeAttachment({ approvedAt: '2026-09-09T00:00:00Z' })],
          }),
        }),
      );
      expect(await screen.findByText('Approved')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    });

    test('no attachments renders no "Transcript & attachments" section at all', async () => {
      mockGetResponses({ debriefs: [], notes: [] });
      const qc = new QueryClient();
      render(buildTree(qc, { meeting: makeMeeting({ attachments: [] }) }));
      await waitFor(() => expect(screen.getByText('Not started')).toBeInTheDocument());
      expect(screen.queryByText(/transcript.*attachments/i)).not.toBeInTheDocument();
    });

    test('the attachment approval list is reachable even while the debrief itself is locked (unfinished meeting)', async () => {
      // EM-09's real repro: a transcript can exist on a meeting whose debrief
      // isn't unlocked yet. It must still be approvable, not hidden behind
      // debrief lifecycle state.
      mockGetResponses({});
      const qc = new QueryClient();
      render(
        buildTree(qc, {
          meeting: makeMeeting({
            startsAt: '2099-01-01T10:00:00.000Z',
            endsAt: '2099-01-01T10:30:00.000Z',
            meri: null,
            attachments: [makeAttachment()],
          }),
        }),
      );
      expect(screen.getByText('Debrief locked')).toBeInTheDocument();
      expect(
        await screen.findByText('meeting-transcript-2026-09-08.txt'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    });
  });
});
