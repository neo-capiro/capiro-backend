import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('opens the outreach-type guidance dialog from its option', () => {
    render(<GoalDecisionSurface {...props()} />);

    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));

    expect(
      screen.getByRole('dialog', { name: 'Requesting a new outreach type' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/What you need/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/A sample email showing the desired outcome/i)).toBeInTheDocument();
  });

  /*
   * There is no endpoint behind this dialog. It previously rendered a "Submit
   * outreach type request" button that validated both fields and then called a
   * handler wired to `() => setRequestOpen(false)` — so the dialog closed and
   * both fields were discarded with nothing recorded anywhere. The test that
   * covered it was named "captures the ... description and sample email", and
   * asserted only that the dialog closed; "captures" was never true.
   *
   * A control with no endpoint is absent or disabled with a stated reason. The
   * dialog now says where to send the request and offers no submit at all.
   */
  it('offers no submit control, because there is no endpoint behind it', () => {
    render(<GoalDecisionSurface {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));

    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing here is submitted/i)).toBeInTheDocument();
  });

  it('tells the user where the request actually has to go', () => {
    render(<GoalDecisionSurface {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));

    // Naming the real route matters: without it the dialog is a dead end that
    // explains nothing. Scoped to the dialog because "Capiro contact" appears
    // in both the explanation and a field label.
    const dialog = screen.getByRole('dialog', { name: 'Requesting a new outreach type' });
    expect(within(dialog).getByText(/no in-product request form yet/i)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Capiro contact/i).length).toBeGreaterThan(0);
  });

  it('offers exactly one dismiss control, not a Close beside a Cancel', () => {
    render(<GoalDecisionSurface {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));

    const dialog = screen.getByRole('dialog', { name: 'Requesting a new outreach type' });
    // Removing the submit turned the footer's "Cancel" into a second "Close".
    expect(within(dialog).getAllByRole('button')).toHaveLength(1);
  });

  it('still closes, and keeps the two supported types reachable behind it', () => {
    render(<GoalDecisionSurface {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Request New Outreach Type/i }));
    const dialog = screen.getByRole('dialog', { name: 'Requesting a new outreach type' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(
      screen.queryByRole('dialog', { name: 'Requesting a new outreach type' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Request a meeting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share an update/i })).toBeInTheDocument();
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