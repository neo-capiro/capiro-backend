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

  it('shows only the two standard outreach types and the new outreach request option', () => {
    render(<GoalDecisionSurface {...props()} />);

    expect(screen.getByRole('button', { name: /Request a meeting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share an update/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request New Outreach Type/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Protect funding/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Custom outcome/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Desired outcome')).not.toBeInTheDocument();
    expect(screen.queryAllByText('Required')).toHaveLength(3);
    expect(screen.queryByText('Request a 30-minute staff briefing')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Desired outcome/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Ask mode/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Explicit ask/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Why now/i)).not.toBeInTheDocument();
  });

  it('opens a new outreach type request form from its option', () => {
    render(<GoalDecisionSurface {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));

    expect(screen.getByRole('dialog', { name: 'Request New Outreach Type' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Describe what you want to request/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sample email of the desired outcome/i)).toBeInTheDocument();
  });

  it('captures the new outreach type description and sample email before closing the form', () => {
    render(<GoalDecisionSurface {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));
    fireEvent.change(screen.getByLabelText(/Describe what you want to request/i), {
      target: { value: 'Ask an office to introduce us to the program lead.' },
    });
    fireEvent.change(screen.getByLabelText(/Sample email of the desired outcome/i), {
      target: { value: 'Could you connect us with the program lead?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit outreach type request' }));

    expect(screen.queryByRole('dialog', { name: 'Request New Outreach Type' })).not.toBeInTheDocument();
  });

  it('requires the complete deterministic read-back including objective', async () => {
    const value = props();
    render(<GoalDecisionSurface {...value} />);

    fireEvent.change(screen.getByLabelText(/^Campaign goal/i), { target: { value: 'Protect funding' } });
    fireEvent.change(screen.getByLabelText(/^Topic/i), { target: { value: 'Ground Robotics' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm goal' }));

    expect(await screen.findByText(/goal, objective, topic, and an outreach type are required/i)).toBeInTheDocument();
    expect(value.applyCommands).not.toHaveBeenCalled();
  });

  it('commits the exact goal batch only after confirmation', async () => {
    const value = props();
    render(<GoalDecisionSurface {...value} />);

    fireEvent.change(screen.getByLabelText(/^Campaign goal/i), { target: { value: 'Protect funding' } });
    fireEvent.change(screen.getByLabelText(/^Topic/i), { target: { value: 'Ground Robotics' } });
    fireEvent.change(screen.getByLabelText(/^Objective/i), { target: { value: 'Educate HASC staff' } });
    fireEvent.click(screen.getByRole('button', { name: /Request a meeting/i }));
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
      text: 'Request a 30-minute staff briefing',
    });
  });
});