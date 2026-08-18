import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  OutreachV3ContextCandidate,
  OutreachV3ContextReviewResponse,
  OutreachV3SessionEnvelope,
} from './contracts.js';
import {
  ContextReviewSurface,
  type ContextReviewSurfaceProps,
} from './ContextReviewSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 6,
    specHash: 'hash-6',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: true,
      contextReady: false,
      contextEvidenceReady: false,
      blockers: [
        'CONTEXT_NOT_REVIEWED',
        'CONTEXT_HAS_UNVERIFIED_EVIDENCE',
        'STRATEGY_INCOMPLETE',
        'GENERATION_NOT_AVAILABLE',
      ],
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
      sponsor: {
        kind: 'client',
        label: null,
        clientRefs: [{ clientId: '11111111-1111-4111-8111-111111111111' }],
      },
      targeting: {
        criteria: {
          notes: 'HASC staff',
          governmentLevels: ['federal'],
          chambers: ['house'],
          committees: ['HASC'],
          agencies: [],
          states: [],
          relationshipPreference: 'any',
          includeStaff: true,
          includePrincipals: true,
        },
        selectedTargetRefs: [
          {
            targetKey: 'directory_staff:staff-1',
            locator: { source: 'directory_staff', id: 'staff-1' },
            displayName: 'Jordan Miller',
            title: 'Legislative Director',
            organization: 'HASC',
            email: 'jordan@example.test',
            clientId: null,
            roleStatus: 'current',
            snapshotHash: 'a'.repeat(64),
            jurisdiction: {
              governmentLevel: 'federal',
              chamber: 'House',
              state: null,
              district: null,
              committees: ['HASC'],
              issueAreas: ['Ground Robotics'],
            },
          },
        ],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'personalized_separate', personalization: 'light' },
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

const guidanceCandidate: OutreachV3ContextCandidate = {
  sourceKind: 'memory',
  title: 'Congressional staff writing style',
  summary: 'Use concise, direct language and a clear ask.',
  memoryType: 'writing_preference',
  clientId: '11111111-1111-4111-8111-111111111111',
  verificationClass: 'first_party',
  sensitivity: 'normal',
  instructionsAllowed: true,
  lastVerifiedAt: '2026-08-01T12:00:00.000Z',
  selection: {
    locator: {
      source: 'memory_item',
      id: 'memory-1',
      clientId: '11111111-1111-4111-8111-111111111111',
    },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
  },
};

const targetCandidate: OutreachV3ContextCandidate = {
  sourceKind: 'government',
  category: 'hearing',
  id: 'hearing-1',
  title: 'Jordan Miller robotics portfolio',
  subtitle: 'Current committee portfolio from an authorized target profile source.',
  date: '2026-07-28T12:00:00.000Z',
  href: 'https://example.test/hearing-1',
  selection: {
    locator: { source: 'government_record', category: 'hearing', id: 'hearing-1' },
    contextClass: 'target_specific',
    scope: { kind: 'target', targetKey: 'directory_staff:staff-1' },
  },
};

const documentCandidate: OutreachV3ContextCandidate = {
  sourceKind: 'document',
  attachmentId: '33333333-3333-4333-8333-333333333333',
  clientId: '11111111-1111-4111-8111-111111111111',
  clientName: 'Acme Robotics',
  title: 'Ground robotics capability brief.pdf',
  date: '2026-07-02T12:00:00.000Z',
  selection: {
    locator: {
      source: 'document',
      id: '33333333-3333-4333-8333-333333333333',
      clientId: '11111111-1111-4111-8111-111111111111',
    },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
  },
};

function review(): OutreachV3ContextReviewResponse {
  return {
    sessionId: 'session-1',
    stateVersion: 6,
    specHash: 'hash-6',
    summary: {
      requiredPolicyCount: 1,
      writingGuidanceCount: 0,
      campaignFactCount: 0,
      targetSpecificCount: 0,
      groupSafeCount: 0,
      excludedCount: 0,
      unverifiedEvidenceCount: 1,
    },
    accepted: {
      requiredPolicyRefs: [
        {
          contextKey: 'required_policy:campaign:memory_item:policy-1',
          locator: { source: 'memory_item', id: 'policy-1' },
          contextClass: 'required_policy',
          scope: { kind: 'campaign' },
          title: 'Federal correspondence policy',
          summary: 'Required firm policy for congressional outreach.',
          verificationClass: 'authoritative',
          sensitivity: 'normal',
          instructionsAllowed: true,
          usableAsEvidence: false,
          usableAsWritingGuidance: true,
          snapshotHash: 'b'.repeat(64),
          sourceSnapshot: {
            system: 'institutional_memory',
            version: '1',
            lastVerifiedAt: '2026-08-01T12:00:00.000Z',
          },
        },
      ],
      writingGuidanceRefs: [],
      campaignFactRefs: [],
      targetSpecificRefs: [],
      groupSafeRefs: [],
      excludedRefs: [],
    },
    snapshotRevalidation: [
      {
        contextKey: 'required_policy:campaign:memory_item:policy-1',
        status: 'current',
      },
    ],
    readiness: {
      contextReady: true,
      contextEvidenceReady: false,
      blockers: ['CONTEXT_HAS_UNVERIFIED_EVIDENCE'],
    },
  };
}

function props(candidates: OutreachV3ContextCandidate[] = [guidanceCandidate]): ContextReviewSurfaceProps {
  return {
    session: session(),
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    searchContext: vi.fn(async () => undefined),
    contextCandidates: candidates,
    contextSearchPending: false,
    contextSearchError: null,
    contextReview: review(),
    contextReviewPending: false,
    contextReviewError: null,
  };
}

describe('ContextReviewSurface', () => {
  it('keeps writing guidance visibly separate from evidence and never auto-accepts it', () => {
    const value = props();
    render(<ContextReviewSurface {...value} />);

    expect(screen.getByText('Style is not evidence')).toBeInTheDocument();
    expect(screen.getByText('Congressional staff writing style')).toBeInTheDocument();
    expect(screen.getAllByText('Writing guidance').length).toBeGreaterThan(0);
    // Entering the stage reads, and only reads. applyCommands staying untouched
    // is the governance property; the auto-search asserted below is a read-only
    // capability call that cannot mutate the Campaign Spec.
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('runs one unified search on entry, seeded from the campaign topic', async () => {
    const value = props();
    render(<ContextReviewSurface {...value} />);

    await waitFor(() => expect(value.searchContext).toHaveBeenCalledTimes(1));
    // No source, no intendedClass, no scope: one query across every source, with
    // the class decided per item afterwards.
    expect(value.searchContext).toHaveBeenCalledWith({
      query: 'Ground Robotics',
      clientId: '11111111-1111-4111-8111-111111111111',
      limit: 20,
    });
  });

  it('refuses to accept an ambiguous source until a purpose is chosen', async () => {
    // The guidance candidate is instructionsAllowed, so it could legitimately be
    // read as tone OR as a citable fact. Nothing is preselected and the accept
    // control stays inert until the user says which.
    const value = props();
    render(<ContextReviewSurface {...value} />);

    const accept = screen.getByRole('button', { name: 'Accept context' });
    expect(accept).toBeDisabled();
    fireEvent.click(accept);
    await waitFor(() => expect(value.applyCommands).not.toHaveBeenCalled());
  });

  it('disables a purpose the source cannot serve and says why', () => {
    // A government record hard-codes instructionsAllowed: false in its resolver,
    // so guidance is impossible rather than merely discouraged.
    render(<ContextReviewSurface {...props([targetCandidate])} />);

    const guidance = screen.getByRole('button', { name: 'Writing guidance' });
    expect(guidance).toBeDisabled();
    expect(guidance).toHaveAttribute(
      'title',
      'Only institutional-memory items can carry writing instructions.',
    );
  });

  it('offers documents alongside memory and government, as document locators', async () => {
    const value = props([documentCandidate]);
    render(<ContextReviewSurface {...value} />);

    expect(screen.getByText('Ground robotics capability brief.pdf')).toBeInTheDocument();
    // Documents cannot be guidance, so evidence is unambiguous and preselected.
    fireEvent.click(screen.getByRole('button', { name: 'Accept context' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      {
        type: 'ACCEPT_CONTEXT_REFS',
        schemaVersion: 1,
        payload: {
          selections: [
            {
              locator: {
                source: 'document',
                id: '33333333-3333-4333-8333-333333333333',
                clientId: '11111111-1111-4111-8111-111111111111',
              },
              contextClass: 'campaign_fact',
              scope: { kind: 'campaign' },
            },
          ],
        },
      },
    ]);
  });

  it('reports a dead source without hiding the ones that answered', () => {
    render(
      <ContextReviewSurface
        {...props()}
        contextSourceFailures={[{ source: 'government', message: 'Not Found' }]}
      />,
    );

    expect(screen.getByText('Some context sources could not be searched')).toBeInTheDocument();
    expect(screen.getByText('Government: Not Found')).toBeInTheDocument();
    expect(screen.getByText('Congressional staff writing style')).toBeInTheDocument();
  });

  it('accepts the exact source/class/scope selection only after the user clicks', async () => {
    const value = props();
    render(<ContextReviewSurface {...value} />);

    fireEvent.click(screen.getByRole('button', { name: 'Writing guidance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept context' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    // The class comes from the purpose picked on this card, not from the
    // placeholder the unified search stamped on the candidate.
    expect(value.applyCommands).toHaveBeenCalledWith([
      {
        type: 'ACCEPT_CONTEXT_REFS',
        schemaVersion: 1,
        payload: {
          selections: [
            {
              locator: guidanceCandidate.selection.locator,
              contextClass: 'writing_guidance',
              scope: { kind: 'campaign' },
            },
          ],
        },
      },
    ]);
  });

  it('names the only target a target-specific fact may influence', async () => {
    const value = props([targetCandidate]);
    render(<ContextReviewSurface {...value} />);

    // Campaign-wide until the user narrows it, and named explicitly once they do.
    expect(screen.getByText('Campaign-wide')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'directory_staff:staff-1' },
    });
    expect(screen.getByText('Applies to Jordan Miller only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open source/i })).toHaveAttribute(
      'href',
      'https://example.test/hearing-1',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Accept context' }));
    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      {
        type: 'ACCEPT_CONTEXT_REFS',
        schemaVersion: 1,
        payload: {
          selections: [
            {
              locator: targetCandidate.selection.locator,
              contextClass: 'target_specific',
              scope: { kind: 'target', targetKey: 'directory_staff:staff-1' },
            },
          ],
        },
      },
    ]);
  });

  it('locks required policy and surfaces unverified-evidence blockers', () => {
    render(<ContextReviewSurface {...props()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Accepted' }));

    expect(screen.getByText('Federal correspondence policy')).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Exclude Federal correspondence policy/i)).not.toBeInTheDocument();
    expect(screen.getByText('Unverified evidence blocks strategy readiness')).toBeInTheDocument();
  });
});