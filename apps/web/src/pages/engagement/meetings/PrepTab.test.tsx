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
import type { Meeting, MeetingPrep } from './meetings-types.js';

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

describe('PrepTab', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    apiPatchMock.mockReset();
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
        'Refine, Regenerate, Export PDF and Approve are distinct controls. Approval never implies sharing.',
      ),
    ).toBeInTheDocument();
  });

  test('clicking Approve on a generated prep POSTs the approve endpoint with the exact prep id', async () => {
    apiPostMock.mockResolvedValue({ data: makePrep({ id: 'p42', status: 'approved' }) });
    const qc = new QueryClient();
    render(
      buildTree(qc, {
        meeting: makeMeeting({ preps: [makePrep({ id: 'p42', status: 'generated' })] }),
        aiConfigured: true,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith('/api/engagement/meeting-preps/p42/approve'),
    );
  });

  test('legacy prep is explicitly missing source/attendee verification information', () => {
    render(
      buildTree(new QueryClient(), {
        meeting: makeMeeting({ preps: [makePrep()] }),
        aiConfigured: true,
      }),
    );
    expect(
      screen.getByText(/no source references or attendee verification record/),
    ).toBeInTheDocument();
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
});
