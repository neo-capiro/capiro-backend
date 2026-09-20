// QA gap coverage, same rationale as NotesTab.test.tsx's own header comment:
// PrepTab is ALWAYS mocked wholesale in MeetingDetailPanel.test.tsx (repo
// convention), so it had no direct test file of its own. Written for the
// meeting-drawer navy reskin phase, which added the top-of-tab stage pill and
// the closing rule-reinforcement sentence — real, new behavior that deserves
// real coverage against the actual component, not just via a mock.
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { PrepTab } from './PrepTab.js';
import { AntdMeetingPanelChrome } from './AntdMeetingPanelChrome.js';
import type { Meeting, MeetingPrep } from './meetings-types.js';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const apiPatchMock = vi.fn();
const authState = vi.hoisted(() => ({ userId: 'clerk-u1', orgId: 'org-1' }));
const impersonationState = vi.hoisted(() => ({ actAsTenantSlug: null as string | null }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => authState }));
vi.mock('../../../state/impersonation.js', () => ({ useImpersonation: () => impersonationState }));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: apiPatchMock,
    delete: vi.fn(),
  }),
}));

function makePrep(overrides: Partial<MeetingPrep> = {}): MeetingPrep {
  return {
    id: 'p1',
    status: 'generated',
    agenda: ['Review FY27 markup schedule'],
    talkingPoints: ['Emphasize the district impact numbers'],
    risks: [],
    followUps: [],
    emailEvidence: [],
    summary: 'A short prep summary.',
    provider: 'anthropic',
    model: 'claude',
    sharedAt: null,
    sharedByUserId: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
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
    meri: null,
    contributors: [],
    sharedBy: null,
    ...overrides,
  } as Meeting;
}

function buildTree(qc: QueryClient, props: Parameters<typeof PrepTab>[0]): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <PrepTab {...props} />
      </AntApp>
    </QueryClientProvider>
  );
}

// Only the toast-surfacing test needs the real chrome (AntdMeetingPanelChrome
// wires chrome.error/success to actual antd message.* calls); every other test
// above renders PrepTab bare under AntApp, which leaves it on the no-op
// FALLBACK_CHROME (see meeting-panel-chrome.tsx) since no toast assertions
// were needed there.
function buildTreeWithChrome(qc: QueryClient, props: Parameters<typeof PrepTab>[0]): ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AntApp>
        <AntdMeetingPanelChrome>
          <PrepTab {...props} />
        </AntdMeetingPanelChrome>
      </AntApp>
    </QueryClientProvider>
  );
}

describe('PrepTab', () => {
  beforeEach(() => {
    authState.userId = 'clerk-u1';
    authState.orgId = 'org-1';
    impersonationState.actAsTenantSlug = null;
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({ data: null });
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
  });

  test('shows restored job progress without hiding the previous briefing', async () => {
    apiGetMock.mockImplementation(async (url: string) => ({ data: url.endsWith('/prep-jobs/latest') ? { jobId: 'job1', meetingId: 'm1', status: 'running', stage: 'reviewing', depth: 'deep', prepId: null, errorCode: null, deadlineAt: '2026-09-12T18:00:00Z' } : {} }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(buildTree(qc, { meeting: makeMeeting({ preps: [makePrep()] }), aiConfigured: true }));
    await waitFor(() => expect(screen.getByText(/Preparing your briefing: reviewing/)).toBeInTheDocument());
    expect(screen.getByText('A short prep summary.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel preparation' })).toBeInTheDocument();
    qc.clear();
  });

  test('renders seven named sections and explicit evidence gaps', () => {
    const sections = Object.fromEntries(['recentDevelopments', 'importantEmails', 'previousConversations', 'decisions', 'unresolvedIssues', 'upcomingDevelopments', 'commitments'].map(key => [key, { status: 'source_gap', items: [], gap: 'Source unavailable for ' + key }]));
    const prep = makePrep({ generatedFrom: { briefing: { version: 2, takeaways: [{ text: 'Important client context', factIds: [] }], sections, facts: [], limitations: [], coverage: { extractedBatches: 1, totalBatches: 1, factCount: 12, reviewedFactCount: 12, selectedFactCount: 12, partial: true } } } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(buildTree(qc, { meeting: makeMeeting({ preps: [prep] }), aiConfigured: true }));
    expect(screen.getByRole('heading', { name: 'Decisions already made' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What we committed to doing' })).toBeInTheDocument();
    expect(screen.getByText(/12 extracted facts checked/)).toBeInTheDocument();
    expect(screen.queryByText('A short prep summary.')).not.toBeInTheDocument();
    qc.clear();
  });

  test('no prep yet shows the "Not started" stage pill and the empty state', () => {
    const qc = new QueryClient();
    render(buildTree(qc, { meeting: makeMeeting({ preps: [] }), aiConfigured: true }));
    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.getByText('No prep generated yet')).toBeInTheDocument();
  });

  test('a failed generation shows the "Generation failed" stage pill and a retry action', () => {
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({ preps: [makePrep({ status: 'failed' })] }),
        aiConfigured: true,
      }),
    );
    expect(screen.getByText('Generation failed')).toBeInTheDocument();
    expect(screen.getByText('Prep generation failed')).toBeInTheDocument();
    expect(screen.getByText('Retry generation')).toBeInTheDocument();
  });

  test('a stale prep shows the "Stale" stage pill and the stale banner, not the freshly-drafted banner', () => {
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({ preps: [makePrep({ status: 'stale' })] }),
        aiConfigured: true,
      }),
    );
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText(/context changed since this prep was generated/i)).toBeInTheDocument();
    expect(screen.queryByText(/meri drafted this prep from your client context/i)).toBeNull();
  });

  test('an approved prep shows the "Approved" stage pill and the approved control, not an Approve button', () => {
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({ preps: [makePrep({ status: 'approved' })] }),
        aiConfigured: true,
      }),
    );
    // Two distinct navy "Approved" signals now coexist: the top stage pill and
    // ArtifactActionBar's own approved chip — both real, not a duplicate bug.
    expect(screen.getAllByText('Approved').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  test('a generated (not yet approved) prep shows the "Draft" stage pill', () => {
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({ preps: [makePrep({ status: 'generated' })] }),
        aiConfigured: true,
      }),
    );
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  test('a populated prep body ends with the rule-reinforcement sentence', () => {
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({ preps: [makePrep({ status: 'generated' })] }),
        aiConfigured: true,
      }),
    );
    expect(
      screen.getByText(
        'Refine, Regenerate, Export PDF and Email PDF are distinct controls. A saved prep is never shared until you send it.',
      ),
    ).toBeInTheDocument();
  });

  test('legacy prep is explicitly missing source information', () => {
    render(
      buildTree(new QueryClient(), {
        meeting: makeMeeting({ preps: [makePrep()] }),
        aiConfigured: true,
      }),
    );
    expect(screen.getByText(/no source references/)).toBeInTheDocument();
  });

  test('source links, original excerpts, roster and email evidence are visible', () => {
    const prep = makePrep({
      emailEvidence: ['Mia asked for a timeline.'],
      generatedFrom: {
        clientId: null,
        grounding: {
          version: 1,
          contentEdited: false,
          attendees: [{ id: 'a1', name: 'Mia LaPinta', email: 'mia@example.com' }],
          sources: [
            {
              id: 'mail:mail1',
              kind: 'mail',
              title: 'Timeline request',
              recordId: 'mail1',
              observedAt: '2026-09-07',
              excerpt: '{"snippet":"Mia asked for an implementation timeline."}',
            },
          ],
          references: [{ section: 'emailEvidence', itemIndex: 0, sourceIds: ['mail:mail1'] }],
          limitations: ['Only the email excerpt was available.'],
        },
      },
    });
    render(
      buildTree(new QueryClient(), { meeting: makeMeeting({ preps: [prep] }), aiConfigured: true }),
    );
    expect(screen.getByText('Mia asked for a timeline.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Source 1: Timeline request' })).toHaveAttribute(
      'href',
      '#prep-p1-source-0',
    );
    expect(screen.getByText('Mia LaPinta', { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText(/snippet: Mia asked for an implementation timeline/),
    ).toBeInTheDocument();
    expect(screen.getByText('Only the email excerpt was available.')).toBeInTheDocument();
  });

  test('edited and reassigned prep preserves historical sources with warnings but no stale claim links', () => {
    const prep = makePrep({
      generatedFrom: {
        clientId: 'old-client',
        grounding: {
          version: 1,
          contentEdited: true,
          attendees: [],
          sources: [
            {
              id: 'mail:mail1',
              kind: 'mail',
              title: 'Original context',
              recordId: 'mail1',
              observedAt: null,
              excerpt: 'Original source text.',
            },
          ],
          references: [{ section: 'summary', itemIndex: 0, sourceIds: ['mail:mail1'] }],
          limitations: [],
        },
      },
    });
    render(
      buildTree(new QueryClient(), { meeting: makeMeeting({ preps: [prep] }), aiConfigured: true }),
    );
    expect(screen.getByText(/edited after generation/)).toBeInTheDocument();
    expect(screen.getByText(/client changed after this prep was generated/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Source 1:/ })).not.toBeInTheDocument();
    expect(screen.getByText('Original context')).toBeInTheDocument();
  });

  test.each(['cancelled', 'canceled'])(
    '%s meeting preserves prep but disables regeneration',
    (status) => {
      render(
        buildTree(new QueryClient(), {
          meeting: makeMeeting({ status, preps: [makePrep()] }),
          aiConfigured: true,
        }),
      );
      expect(screen.getByText('A short prep summary.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(apiPostMock).not.toHaveBeenCalled();
    },
  );

  // EM-06: internal meetings with no client/attendees/history previously failed
  // generation server-side (no groundable evidence for the "insufficient context"
  // summary) and PrepTab swallowed the rejection entirely — the panel just fell
  // back to "No prep generated yet" with no toast, no error state, no next step.
  // The server-side prompt fix is covered by engagement-ai.prompt.spec.ts; this
  // covers the client half: a rejected generate call must surface a real error
  // to the user instead of disappearing.
  test('a failed Generate with Meri call surfaces the server error message, not a silent no-op', async () => {
    apiPostMock.mockRejectedValue({
      response: { data: { message: 'Meeting prep returned incomplete content. Please retry generation.' } },
    });
    render(
      buildTreeWithChrome(new QueryClient(), {
        meeting: makeMeeting({ preps: [] }),
        aiConfigured: true,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /generate with meri/i }));
    expect(
      await screen.findByText('Meeting prep returned incomplete content. Please retry generation.'),
    ).toBeInTheDocument();
    // Still communicates the no-prep state honestly afterward — no fabricated
    // success, no silently-stuck "Generating" spinner.
    expect(screen.getByText('No prep generated yet')).toBeInTheDocument();
  });

  test('Email PDF renders the prep to an attachment and opens the compose window with teammates', async () => {
    apiPostMock.mockResolvedValue({ data: { id: 'att1', fileName: 'Prep - Budget sync.pdf' } });
    apiGetMock.mockImplementation(async (url: string) => ({
      data: url === '/api/tenant-members'
        ? [{ id: 'u2', email: 'ryan@capiro.ai', name: 'Ryan Anderson' }]
        : url === '/api/engagement/integrations'
          ? [{ id: 'mail-1', provider: 'microsoft_365', status: 'connected', accountEmail: 'neo@capiro.ai' }]
        : url.endsWith('/prep-jobs/latest')
          ? null
          : {},
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(buildTree(qc, { meeting: makeMeeting({ preps: [makePrep()] }), aiConfigured: true }));
    fireEvent.click(screen.getByRole('button', { name: /email pdf/i }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meeting-preps/p1/pdf-attachment'),
    );
    expect(await screen.findByText('Prep - Budget sync.pdf')).toBeInTheDocument();
    expect(screen.getByText('New email')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '+ Add recipient' })).toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/api/tenant-members');
    expect(apiGetMock).not.toHaveBeenCalledWith('/api/users/tenant-members');
    qc.clear();
  });

  test('opens immediately, preserves the draft through PDF failure, and retries the saved prep', async () => {
    let rejectPdf!: (error: unknown) => void;
    apiPostMock.mockImplementation(
      (url: string) =>
        url.endsWith('/pdf-attachment')
          ? new Promise((_resolve, reject) => {
              rejectPdf = reject;
            })
          : Promise.resolve({ data: {} }),
    );
    apiGetMock.mockImplementation(async (url: string) => ({
      data:
        url === '/api/tenant-members'
          ? []
          : url === '/api/engagement/integrations'
            ? [{ id: 'mail-1', provider: 'microsoft_365', status: 'connected', accountEmail: 'neo@capiro.ai' }]
            : null,
    }));
    render(
      buildTree(new QueryClient({ defaultOptions: { queries: { retry: false } } }), {
        meeting: makeMeeting({ preps: [makePrep()] }),
        aiConfigured: true,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /email pdf/i }));
    expect(await screen.findByText('New email')).toBeInTheDocument();
    expect(screen.getByText(/You can keep drafting while it loads/)).toBeInTheDocument();
    const editor = screen
      .getAllByRole('textbox')
      .find((element) => element.hasAttribute('data-placeholder'))!;
    fireEvent.input(editor, { target: { innerHTML: '<p>My retained draft.</p>' } });
    rejectPdf({ response: { data: { message: 'PDF renderer unavailable.' } } });
    expect(await screen.findByText('PDF renderer unavailable.', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(apiPostMock).toHaveBeenLastCalledWith('/api/engagement/meeting-preps/p1/pdf-attachment');
    expect(screen.getByText('My retained draft.')).toBeInTheDocument();
  });
});
