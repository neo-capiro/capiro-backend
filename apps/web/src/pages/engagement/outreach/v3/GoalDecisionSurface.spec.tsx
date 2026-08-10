import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OutreachV3SessionEnvelope } from './contracts.js';
import { GoalDecisionSurface, type GoalDecisionSurfaceProps } from './GoalDecisionSurface.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 1,
    specHash: 'hash-1',
    pendingProposalCount: 0,
    readiness: { blockers: ['GOAL_MISSING', 'SPONSOR_UNDECIDED'] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
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

function props(): GoalDecisionSurfaceProps {
  return {
    session: session(),
    busy: false,
    applyCommands: vi.fn(async () => undefined),
  };
}

describe('GoalDecisionSurface', () => {
  it('starts with the campaign outcome rather than a required client', () => {
    render(<GoalDecisionSurface {...props()} />);
    expect(screen.getByText('What should this campaign accomplish?')).toBeInTheDocument();
    expect(screen.getByText(/Client or sponsor scope is optional/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Search clients/i)).not.toBeInTheDocument();
  });

  it('requires the complete deterministic read-back including objective', async () => {
    const value = props();
    render(<GoalDecisionSurface {...value} />);

    fireEvent.change(screen.getByLabelText(/^Campaign goal/i), { target: { value: 'Protect funding' } });
    fireEvent.change(screen.getByLabelText(/^Topic/i), { target: { value: 'Ground Robotics' } });
    fireEvent.change(screen.getByLabelText(/^Desired outcome/i), { target: { value: 'Request a meeting' } });
    fireEvent.change(screen.getByLabelText(/^Explicit ask/i), { target: { value: 'Request a briefing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm goal' }));

    expect(await screen.findByText(/goal, objective, topic, and desired outcome are required/i)).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('commits the exact goal batch only after confirmation', async () => {
    const value = props();
    render(<GoalDecisionSurface {...value} />);

    fireEvent.change(screen.getByLabelText(/^Campaign goal/i), { target: { value: 'Protect funding' } });
    fireEvent.change(screen.getByLabelText(/^Topic/i), { target: { value: 'Ground Robotics' } });
    fireEvent.change(screen.getByLabelText(/^Objective/i), { target: { value: 'Educate HASC staff' } });
    fireEvent.change(screen.getByLabelText(/^Desired outcome/i), { target: { value: 'Request a meeting' } });
    fireEvent.change(screen.getByLabelText(/^Explicit ask/i), { target: { value: 'Request a 30-minute briefing' } });
    fireEvent.change(screen.getByLabelText(/^Why now/i), { target: { value: 'The mark is below the request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm goal' }));

    await waitFor(() => expect(value.applyCommands).toHaveBeenCalledTimes(1));
    const commands = vi.mocked(value.applyCommands).mock.calls[0]?.[0] ?? [];
    expect(commands.map((entry) => entry.type)).toEqual([
      'SET_GOAL',
      'SET_OBJECTIVE',
      'SET_TOPIC',
      'SET_DESIRED_OUTCOME',
      'SET_ASK',
      'SET_WHY_NOW',
    ]);
    expect(commands.find((entry) => entry.type === 'SET_ASK')?.payload).toEqual({
      mode: 'explicit',
      text: 'Request a 30-minute briefing',
    });
  });
});