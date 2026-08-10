import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope, OutreachV3TargetCandidate } from './contracts.js';
import { TargetWorkspace, type TargetWorkspaceProps } from './TargetWorkspace.js';

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ post: vi.fn(), get: vi.fn() }),
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
    fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));

    fireEvent.change(screen.getByLabelText('NameRequired'), { target: { value: 'Jordan Miller' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));
    expect(await screen.findByText('Enter a valid email address or leave the email blank.')).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jordan@example.test' } });
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
});