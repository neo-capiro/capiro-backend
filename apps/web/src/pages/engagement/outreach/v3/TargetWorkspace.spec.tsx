import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
  OutreachV3TargetCandidate,
  OutreachV3TargetCoverageResponse,
} from './contracts.js';
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

/**
 * A selected target ref, defaulting to the state the reported defect was found
 * in: a real email address AND a historical role, which the server scores as
 * NOT send-ready.
 */
function resolvedTarget(
  overrides: Partial<OutreachV3ResolvedTargetRef> = {},
): OutreachV3ResolvedTargetRef {
  return {
    targetKey: 'directory_member:adams',
    locator: { source: 'directory_member', id: 'adams' },
    displayName: 'Alma Adams',
    title: 'Representative',
    organization: 'House',
    email: 'adams@example.test',
    clientId: null,
    roleStatus: 'historical',
    emailStatus: 'available',
    profileStatus: 'complete',
    snapshotHash: 'snap-1',
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'House',
      state: 'NC',
      district: '12',
      committees: [],
      issueAreas: [],
    },
    sourceSnapshot: { system: 'legistorm', lastVerifiedAt: '2026-08-01T00:00:00.000Z' },
    ...overrides,
  };
}

function withSelected(targets: OutreachV3ResolvedTargetRef[]): OutreachV3SessionEnvelope {
  const envelope = session();
  envelope.spec.targeting.selectedTargetRefs = targets;
  return envelope;
}

/**
 * Mirrors the real `GET …/targets/coverage` payload: `coverage.health` is the
 * per-target `TargetHealthResultV1[]` the server already returns, and
 * `sendReadyCount` is derived from it exactly as `deriveTargetCoverage` does,
 * so a fixture cannot express a badge/meter pair the server could not produce.
 */
function coverageResponse(
  health: Array<{ targetKey: string; readyForSending: boolean; healthCodes: string[] }>,
): OutreachV3TargetCoverageResponse {
  return {
    sessionId: 'session-1',
    stateVersion: 3,
    // Must match session().specHash — a coverage response for another spec
    // describes a different selection and is not trusted.
    specHash: 'hash-3',
    coverage: {
      selectedCount: health.length,
      sendReadyCount: health.filter((entry) => entry.readyForSending).length,
      health,
    },
    snapshotRevalidation: [],
  };
}

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

  it('submits a manual target on name alone, with no audience type required', async () => {
    const value = props();
    renderWorkspace(value);
    fireEvent.click(screen.getByRole('tab', { name: 'Add manually' }));

    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'Jordan Miller' } });
    expect(screen.getByRole('button', { name: 'Add target to campaign' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add target to campaign' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'ADD_TARGET_REFS',
        payload: {
          refs: [expect.objectContaining({ source: 'manual', name: 'Jordan Miller' })],
        },
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

  describe('send-readiness', () => {
    // The reported defect: per-target rows tested `emailStatus === 'available'`
    // alone and printed "Email ready", while the Audience coverage meter
    // directly below counted the server's four-condition `sendReadyCount` and
    // showed 0. Live repro: Rep. Alma Adams and Rep. Pete Aguilar both read
    // "EMAIL READY" while also carrying a HISTORICAL role badge.
    it('does not call a target with an email but a non-current role "Email ready"', () => {
      const value = props();
      value.session = withSelected([resolvedTarget()]);
      value.coverage = coverageResponse([
        { targetKey: 'directory_member:adams', readyForSending: false, healthCodes: ['ROLE_HISTORICAL'] },
      ]);
      renderWorkspace(value);
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }));

      expect(screen.queryByText('Email ready')).not.toBeInTheDocument();
      expect(screen.getByText('Not send-ready')).toBeInTheDocument();
    });

    it('names the specific blocking reason rather than a generic warning', () => {
      const value = props();
      value.session = withSelected([resolvedTarget()]);
      value.coverage = coverageResponse([
        {
          targetKey: 'directory_member:adams',
          readyForSending: false,
          healthCodes: ['ROLE_HISTORICAL', 'PROFILE_LIMITED'],
        },
      ]);
      renderWorkspace(value);
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }));

      expect(
        screen.getByText(/Blocking send: Former role — no longer in this office\./i),
      ).toBeInTheDocument();
      // PROFILE_LIMITED is reported as health but does NOT block sending, so
      // quoting it as a reason would claim a blocker the meter never counted.
      expect(screen.queryByText(/limited/i)).not.toBeInTheDocument();
    });

    it('reads the badge and the coverage meter off the same server health rows', () => {
      const value = props();
      value.session = withSelected([
        resolvedTarget(),
        resolvedTarget({
          targetKey: 'directory_member:aguilar',
          displayName: 'Pete Aguilar',
          email: 'aguilar@example.test',
          roleStatus: 'current',
        }),
      ]);
      value.coverage = coverageResponse([
        { targetKey: 'directory_member:adams', readyForSending: false, healthCodes: ['ROLE_HISTORICAL'] },
        { targetKey: 'directory_member:aguilar', readyForSending: true, healthCodes: [] },
      ]);
      renderWorkspace(value);
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }));

      expect(screen.getByText('Send ready')).toBeInTheDocument();
      expect(screen.getByText('Not send-ready')).toBeInTheDocument();
      // The meter's own wording now matches the rows it summarizes.
      expect(screen.getByText('1 send-ready')).toBeInTheDocument();
      expect(screen.getByText(/1 not send-ready · former role \(1\)/i)).toBeInTheDocument();
    });

    it('keeps the meter honest with no coverage response, where email presence used to be counted', () => {
      // Previously `coverage?.coverage.sendReadyCount ?? selected.filter(t =>
      // Boolean(t.email)).length` — a DIFFERENT predicate from both the badge
      // and the server, so this exact case reported "1 email-ready" for a
      // target no send could ever go to.
      const value = props();
      value.session = withSelected([resolvedTarget()]);
      value.coverage = undefined;
      renderWorkspace(value);

      expect(screen.getByText('0 send-ready')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }));
      expect(screen.getByText('Not send-ready')).toBeInTheDocument();
    });

    it('detects duplicate emails across the selection without a coverage response', () => {
      const value = props();
      value.session = withSelected([
        resolvedTarget({ roleStatus: 'current' }),
        resolvedTarget({
          targetKey: 'directory_staff:shared',
          displayName: 'Shared Inbox',
          roleStatus: 'current',
          email: 'ADAMS@example.test',
        }),
      ]);
      value.coverage = undefined;
      renderWorkspace(value);
      fireEvent.click(screen.getByRole('tab', { name: /^Selected/ }));

      expect(
        screen.getAllByText(/Shares an email address with another selected target/i),
      ).toHaveLength(2);
      expect(screen.getByText('0 send-ready')).toBeInTheDocument();
    });

    it('reports a search result as readiness unknown rather than ready', () => {
      // A TargetCandidateV1 carries no profileStatus, and duplicate detection
      // is a property of the selected set, so two of the four server
      // conditions are unknowable for an unselected candidate. It may be
      // proven not-ready, never proven ready.
      renderWorkspace(props());

      expect(screen.getByText('Readiness unknown')).toBeInTheDocument();
      expect(screen.queryByText('Email ready')).not.toBeInTheDocument();
      expect(screen.queryByText('Send ready')).not.toBeInTheDocument();
    });

    it('states the blocker on a search result that is provably not send-ready', () => {
      const value = props();
      value.targetCandidates = [{ ...candidate, emailStatus: 'missing', email: null }];
      renderWorkspace(value);

      expect(screen.getByText('Not send-ready')).toBeInTheDocument();
      expect(screen.getByText(/Blocking send: No email address on file\./i)).toBeInTheDocument();
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
      // (no timestamp anywhere in the contract) — a real, computed count is
      // shown instead of a fabricated date.
      //
      // It must NOT say "email-ready": SavedAudienceMember carries only an
      // email, so this counts email presence, whereas send-readiness is a
      // four-condition predicate. The old wording invited a comparison with
      // the Audience coverage meter that the data cannot support.
      expect(screen.getByText(/1 of 2 with an email address/i)).toBeInTheDocument();
      expect(screen.queryByText(/email-ready/i)).not.toBeInTheDocument();
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