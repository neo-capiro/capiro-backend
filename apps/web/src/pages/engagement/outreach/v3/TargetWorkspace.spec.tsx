import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope, OutreachV3TargetCandidate } from './contracts.js';
import { TargetWorkspace, type TargetWorkspaceProps } from './TargetWorkspace.js';
import { listSavedOutreachAudiences } from '../../../../vnext/pages/engagement/engagement-api.js';

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ post: vi.fn(), get: vi.fn() }),
}));

// Item 4's real, already-wired read endpoint — mocked here the same way
// useApi is above, so these tests control exactly what the Saved Audiences
// tab sees without hitting the network layer.
vi.mock('../../../../vnext/pages/engagement/engagement-api.js', () => ({
  listSavedOutreachAudiences: vi.fn(),
}));

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 3,
    specHash: 'hash-3',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: false,
      targetsReady: false,
      blockers: ['TARGET_CRITERIA_MISSING', 'TARGETS_MISSING', 'GENERATION_NOT_AVAILABLE'],
    },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Protect funding',
        objective: 'Educate staff',
        topic: 'Ground Robotics',
        desiredOutcome: 'Request a meeting',
        ask: { mode: 'explicit', text: 'Request a staff briefing' },
        whyNow: 'Current mark',
      },
      sponsor: { kind: 'none', label: null, clientRefs: [] },
      targeting: {
        criteria: null,
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: null,
        tone: null,
        length: 'undecided',
        customLengthInstruction: null,
      },
    },
  };
}

const candidate: OutreachV3TargetCandidate = {
  recommendationRef: `orec_${'a'.repeat(64)}`,
  targetKey: 'directory_staff:staff-1',
  locator: { source: 'directory_staff', id: 'staff-1' },
  displayName: 'Alex Morgan',
  title: 'Professional Staff Member',
  organization: 'House Armed Services Committee',
  email: 'alex@example.test',
  clientId: null,
  score: 0.91,
  signals: [{ code: 'committee_match', label: 'Committee match: HASC' }],
  roleStatus: 'current',
  emailStatus: 'available',
  jurisdiction: {
    governmentLevel: 'federal',
    chamber: 'House',
    state: null,
    district: null,
    committees: ['HASC'],
    issueAreas: ['Ground Robotics'],
  },
};

function props(): TargetWorkspaceProps {
  return {
    session: session(),
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    searchTargets: vi.fn(async () => undefined),
    targetCandidates: [candidate],
    targetSearchPending: false,
    targetSearchError: null,
    getTargetProfile: vi.fn(async () => undefined),
    targetProfile: undefined,
    targetProfilePending: false,
    coverage: undefined,
    coveragePending: false,
  };
}

function renderWorkspace(value: TargetWorkspaceProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TargetWorkspace {...value} />
    </QueryClientProvider>,
  );
}

describe('TargetWorkspace', () => {
  it('may load read-only recommendations but never commits criteria or targets on mount', async () => {
    const value = props();
    renderWorkspace(value);

    await waitFor(() => expect(value.searchTargets).toHaveBeenCalledTimes(1));
    expect(value.searchTargets).toHaveBeenCalledWith({
      query: 'Ground Robotics',
      clientId: undefined,
      sources: [],
      limit: 20,
    });
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('commits target criteria only after an explicit Search action', async () => {
    const value = props();
    renderWorkspace(value);
    await waitFor(() => expect(value.searchTargets).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'SET_TARGET_CRITERIA', schemaVersion: 1 }),
    ]);
    await waitFor(() => expect(value.searchTargets).toHaveBeenCalledTimes(2));
  });

  it('validates manual target identity and keeps Save to Directory off', async () => {
    const value = props();
    renderWorkspace(value);
    fireEvent.click(screen.getByRole('tab', { name: 'Add manually' }));

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'Jordan Miller' } });
    fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));
    expect(await screen.findByText('Enter a valid email address or leave the email blank.')).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Email/i), { target: { value: 'jordan@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ADD_TARGET_REFS',
        payload: {
          refs: [
            expect.objectContaining({
              source: 'manual',
              name: 'Jordan Miller',
              email: 'jordan@example.test',
            }),
          ],
        },
      }),
    ]);
    expect(screen.getByText(/Saving to the shared Directory remains off/i)).toBeInTheDocument();
  });

  it('sends the declared audience type for a manual target, or null when left unset', async () => {
    const value = props();
    renderWorkspace(value);
    fireEvent.click(screen.getByRole('tab', { name: 'Add manually' }));

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'Jordan Miller' } });
    fireEvent.change(screen.getByLabelText(/Audience type/i), {
      target: { value: 'client_executive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ADD_TARGET_REFS',
        payload: {
          refs: [expect.objectContaining({ source: 'manual', audienceType: 'client_executive' })],
        },
      }),
    ]);

    (value.applyCommands as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'Alex Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));
    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: { refs: [expect.objectContaining({ source: 'manual', audienceType: null })] },
      }),
    ]);
  });

  describe('signal pills (item 5)', () => {
    it('renders candidate signals as tone-driven pill components instead of joined plain text', () => {
      renderWorkspace(props());

      const pill = screen.getByText('Committee match: HASC');
      expect(pill.className).toContain('eng-pill');
      // 'committee_match' matches the "obvious mapping" keyword heuristic
      // (…match…) and renders navy; anything without an obvious mapping
      // falls back to gray, never plain unstyled text.
      expect(pill.className).toContain('eng-pill--navy');
    });
  });

  describe('Saved audiences (item 4)', () => {
    it('was previously hard-disabled', () => {
      // Documents the bug this phase fixes: the tab used to render with
      // `disabled` and a "not available in Phase 6" title regardless of the
      // real listSavedOutreachAudiences data. Guards against a regression
      // back to that state.
      renderWorkspace(props());
      expect(screen.getByRole('tab', { name: 'Saved audiences' })).toBeEnabled();
    });

    it('renders the rule text, the audience card list, and a navy member-count pill', async () => {
      vi.mocked(listSavedOutreachAudiences).mockResolvedValue([
        {
          id: 'aud-1',
          kind: 'list',
          name: 'HASC Staff',
          members: [
            {
              id: 'mem-1',
              source: 'directory_staff',
              sourceRefId: 'staff-9',
              name: 'Jamie Lee',
              email: 'jamie@example.test',
              title: 'Staff Director',
              office: 'HASC',
            },
            {
              id: 'mem-2',
              source: 'directory_staff',
              sourceRefId: null,
              name: 'No Email Person',
              email: '',
              title: null,
              office: null,
            },
          ],
        },
      ]);
      const value = props();
      renderWorkspace(value);

      fireEvent.click(screen.getByRole('tab', { name: 'Saved audiences' }));

      expect(
        await screen.findByText(
          /Reusable audiences are a source of targets, never a delivery mode/i,
        ),
      ).toBeInTheDocument();
      expect(await screen.findByText('HASC Staff')).toBeInTheDocument();
      // "Updated" has no backing field on SavedAudience/SavedAudienceMember
      // (no timestamp anywhere in the contract) — real, computed email-ready
      // coverage is shown instead of a fabricated date.
      expect(screen.getByText(/1 of 2 email-ready/i)).toBeInTheDocument();
      expect(screen.getByLabelText('2 members')).toHaveClass('eng-pill', 'eng-pill--navy');
    });

    it('shows a real empty state when no saved audiences exist yet', async () => {
      vi.mocked(listSavedOutreachAudiences).mockResolvedValue([]);
      renderWorkspace(props());

      fireEvent.click(screen.getByRole('tab', { name: 'Saved audiences' }));

      expect(await screen.findByText('No saved audiences yet')).toBeInTheDocument();
    });

    it('"Add all" resolves every member into the same target list other sources populate', async () => {
      vi.mocked(listSavedOutreachAudiences).mockResolvedValue([
        {
          id: 'aud-1',
          kind: 'list',
          name: 'HASC Staff',
          members: [
            {
              id: 'mem-1',
              source: 'directory_staff',
              sourceRefId: 'staff-9',
              name: 'Jamie Lee',
              email: 'jamie@example.test',
              title: 'Staff Director',
              office: 'HASC',
            },
            {
              id: 'mem-2',
              source: 'directory_staff',
              sourceRefId: null,
              name: 'No Email Person',
              email: '',
              title: null,
              office: null,
            },
          ],
        },
      ]);
      const value = props();
      renderWorkspace(value);

      fireEvent.click(screen.getByRole('tab', { name: 'Saved audiences' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add all' }));

      await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
      // One command per member (same ADD_TARGET_REFS shape addCandidate/
      // addManual already use), not a distinct "audience" mutation — a
      // resolved-into-the-same-list source, never its own delivery mode.
      expect(value.applyCommands).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'ADD_TARGET_REFS',
          payload: {
            refs: [expect.objectContaining({ source: 'directory_staff', id: 'staff-9' })],
          },
        }),
        expect.objectContaining({
          type: 'ADD_TARGET_REFS',
          payload: {
            refs: [expect.objectContaining({ source: 'manual', id: 'mem-2', name: 'No Email Person' })],
          },
        }),
      ]);
    });
  });
});