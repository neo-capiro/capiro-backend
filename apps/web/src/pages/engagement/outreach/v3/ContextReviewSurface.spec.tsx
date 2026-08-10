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
    expect(value.searchContext).not.toHaveBeenCalled();
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('accepts the exact source/class/scope selection only after the user clicks', async () => {
    const value = props();
    render(<ContextReviewSurface {...value} />);

    fireEvent.click(screen.getByRole('button', { name: 'Accept context' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    expect(value.applyCommands).toHaveBeenCalledWith([
      {
        type: 'ACCEPT_CONTEXT_REFS',
        schemaVersion: 1,
        payload: { selections: [guidanceCandidate.selection] },
      },
    ]);
  });

  it('names the only target a target-specific fact may influence', () => {
    render(<ContextReviewSurface {...props([targetCandidate])} />);
    expect(screen.getByText('Applies to Jordan Miller only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open source/i })).toHaveAttribute(
      'href',
      'https://example.test/hearing-1',
    );
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