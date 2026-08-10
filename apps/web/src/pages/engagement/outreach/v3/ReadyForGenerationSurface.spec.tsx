import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from './contracts.js';
import {
  ReadyForGenerationSurface,
  type ReadyForGenerationSurfaceProps,
} from './ReadyForGenerationSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 9,
    specHash: 'abcdef0123456789',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: true,
      contextReady: true,
      contextEvidenceReady: true,
      strategyReady: true,
      blockers: [
        'GENERATION_NOT_AVAILABLE',
        'DRAFTS_NOT_AVAILABLE',
        'PREFLIGHT_NOT_AVAILABLE',
      ],
    },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Protect funding',
        objective: 'Educate staff',
        topic: 'Ground Robotics',
        desiredOutcome: 'Request a meeting',
        ask: { mode: 'explicit', text: 'Request a briefing' },
        whyNow: 'Current mark',
      },
      sponsor: { kind: 'none', label: null, clientRefs: [] },
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
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'uniform_separate', personalization: 'none' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: 'Protect funding through staff education',
        tone: 'Direct and professional',
        length: 'short',
        customLengthInstruction: null,
      },
    },
  };
}

function props(): ReadyForGenerationSurfaceProps {
  return { session: session(), onFinish: vi.fn() };
}

describe('ReadyForGenerationSurface', () => {
  it('states the next authority boundary instead of rendering fake generation or send actions', () => {
    render(<ReadyForGenerationSurface {...props()} />);

    expect(screen.getByText('The campaign plan is ready for governed generation')).toBeInTheDocument();
    expect(screen.getByText(/No sender, test send, final send, provider call, or delivery retry/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send/i })).not.toBeInTheDocument();
  });

  it('only offers the safe Finish later action', () => {
    const value = props();
    render(<ReadyForGenerationSurface {...value} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish later' }));
    expect(value.onFinish).toHaveBeenCalledTimes(1);
  });
});