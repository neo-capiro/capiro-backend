import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Session durability (reliability repair, section 7): a reload/remount of
 * this route must resume an existing Outreach V3 campaign rather than
 * silently minting a new one and discarding its generation job/drafts.
 *
 * These tests exercise the actual create-vs-resume branching logic in
 * OutreachV3CompleteRoute directly (not through the full OutreachView state
 * machine), mocking only the network boundary (outreach-v3-api) and the
 * downstream workspace component.
 */

const createSessionMock = vi.fn();
const getSessionMock = vi.fn();

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));

vi.mock('./outreach-v3-api.js', async () => {
  const actual = await vi.importActual<typeof import('./outreach-v3-api.js')>(
    './outreach-v3-api.js',
  );
  return {
    ...actual,
    createOutreachV3Session: (...args: unknown[]) => createSessionMock(...args),
    getOutreachV3Session: (...args: unknown[]) => getSessionMock(...args),
  };
});

vi.mock('../../../../vnext/pages/engagement/VNextOutreachPhase1Workspace.js', () => ({
  VNextOutreachPhase1Workspace: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="phase1-workspace" data-session-id={sessionId} />
  ),
}));

import { OutreachV3CompleteRoute } from './OutreachV3CompleteRoute.js';

function envelope(sessionId: string) {
  return {
    session: { id: sessionId, title: 'Test campaign', status: 'active' as const },
    currentStateVersion: 1,
    specHash: 'a'.repeat(64),
    pendingProposalCount: 0,
    readiness: { blockers: [] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1' as const,
      goal: {
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'none' as const, text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided' as const },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'undecided' as const, personalization: 'undecided' as const },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: { campaignAngle: null, tone: null, length: 'undecided' as const, customLengthInstruction: null },
    },
  };
}

function renderRoute(props: { sessionId?: string | null; onSessionReady?: (id: string) => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OutreachV3CompleteRoute
        clients={[]}
        selectedClientId={null}
        aiConfigured={true}
        emailConnected={true}
        sendFrom={null}
        sendableInboxes={[]}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
        onOpenClassic={vi.fn()}
        sessionId={props.sessionId ?? null}
        onSessionReady={props.onSessionReady}
      />
    </QueryClientProvider>,
  );
}

describe('OutreachV3CompleteRoute session durability', () => {
  beforeEach(() => {
    createSessionMock.mockReset();
    getSessionMock.mockReset();
  });

  it('creates a NEW session when no durable sessionId is provided (fresh "New Outreach" entry point)', async () => {
    createSessionMock.mockResolvedValueOnce(envelope('fresh-session-1'));
    const onSessionReady = vi.fn();

    renderRoute({ sessionId: null, onSessionReady });

    await waitFor(() => expect(createSessionMock).toHaveBeenCalledTimes(1));
    expect(getSessionMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('phase1-workspace')).toHaveAttribute(
        'data-session-id',
        'fresh-session-1',
      ),
    );
    await waitFor(() => expect(onSessionReady).toHaveBeenCalledWith('fresh-session-1'));
  });

  it('RESUMES the exact existing session when a durable sessionId is provided (reload/remount case) — never creates a new one', async () => {
    getSessionMock.mockResolvedValueOnce(envelope('existing-session-42'));

    renderRoute({ sessionId: 'existing-session-42' });

    await waitFor(() => expect(getSessionMock).toHaveBeenCalledWith(expect.anything(), 'existing-session-42'));
    expect(createSessionMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('phase1-workspace')).toHaveAttribute(
        'data-session-id',
        'existing-session-42',
      ),
    );
  });

  it('reports the resumed session id back via onSessionReady (so the URL stays in sync on resume too)', async () => {
    getSessionMock.mockResolvedValueOnce(envelope('existing-session-99'));
    const onSessionReady = vi.fn();

    renderRoute({ sessionId: 'existing-session-99', onSessionReady });

    await waitFor(() => expect(onSessionReady).toHaveBeenCalledWith('existing-session-99'));
  });
});
