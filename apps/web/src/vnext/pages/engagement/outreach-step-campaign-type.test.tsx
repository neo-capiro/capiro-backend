import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OutreachCampaignTypeStep } from './outreach-step-campaign-type.js';
import {
  OUTREACH_FORMAT_MARKER,
  OUTREACH_TEMPLATE_MARKER,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
} from './outreach-campaign-flow.js';
import type {
  OutreachV3Command,
  OutreachV3ResolvedContextRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';

/**
 * Step 1 of the campaign builder. Its two load-bearing properties: a tile click
 * writes nothing until the user confirms, and confirming never invents a
 * subject line for a campaign the user has not named yet.
 */

function guidanceRef(title: string): OutreachV3ResolvedContextRef {
  return {
    contextKey: `ctx:${title}`,
    locator: { source: 'manual', id: title },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
    title,
    summary: '',
    verificationClass: 'user_supplied',
    sensitivity: 'normal',
    instructionsAllowed: true,
    usableAsEvidence: false,
    usableAsWritingGuidance: true,
    snapshotHash: 'hash',
  };
}

function session(
  topic: string | null,
  writingGuidanceRefs: OutreachV3ResolvedContextRef[] = [],
): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 1,
    specHash: 'hash-1',
    pendingProposalCount: 0,
    readiness: { blockers: ['GOAL_MISSING'] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: null,
        objective: null,
        topic,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs,
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

function props(over: Partial<OutreachBuilderStepCommon> = {}): OutreachBuilderStepCommon {
  return {
    sessionId: 'session-1',
    session: session(null),
    campaignType: null,
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    toast: vi.fn(),
    onNext: vi.fn(),
    primaryLabel: 'Continue with Send update',
    ...over,
  };
}

function commandsFrom(applyCommands: unknown): OutreachV3Command[] {
  const mock = vi.mocked(applyCommands as (commands: OutreachV3Command[]) => Promise<unknown>);
  return mock.mock.calls.at(0)?.[0] ?? [];
}

function payloadValue(commands: OutreachV3Command[], type: string): unknown {
  const found = commands.find((command) => command.type === type);
  return (found?.payload as { value?: unknown } | undefined)?.value;
}

describe('OutreachCampaignTypeStep', () => {
  it('offers the prototype’s three campaign types with their exact copy', () => {
    render(<OutreachCampaignTypeStep {...props()} />);

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    for (const title of ['Request a meeting', 'Send update', 'Custom']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(
      screen.getByText(
        'Ask an office for a focused staff briefing. Its builder adds an explicit ask to every draft and reads meeting history first.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Tell stakeholders what changed and what it means for them. Its builder adds no ask unless you write one.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Describe the campaign in prose. Its builder asks for the purpose before anything is written.',
      ),
    ).toBeInTheDocument();
  });

  it('pins the step’s heading copy, which the builder shell renders above it', () => {
    expect(OUTREACH_BUILDER_STEP_TITLES.workflow).toBe('What kind of campaign is this?');
    expect(OUTREACH_BUILDER_STEP_SUBLINES.workflow).toBe(
      'Each campaign type has its own builder workflow — it decides the shape of every draft and which context Capiro reads.',
    );
  });

  it('defaults to Send update when the campaign has no type yet', () => {
    render(<OutreachCampaignTypeStep {...props()} />);

    expect(screen.getByRole('radio', { name: /^Send update/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Request a meeting/ })).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Continue with Send update' }),
    ).toBeInTheDocument();
  });

  it('starts on the campaign’s saved type', () => {
    render(<OutreachCampaignTypeStep {...props({ campaignType: 'custom' })} />);

    expect(screen.getByRole('radio', { name: /^Custom/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Send update/ })).not.toBeChecked();
  });

  it('keeps a tile click local and re-labels the button before anything is saved', () => {
    const step = props();
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('radio', { name: /^Request a meeting/ }));

    expect(screen.getByRole('radio', { name: /^Request a meeting/ })).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Continue with Request a meeting' }),
    ).toBeInTheDocument();
    expect(step.applyCommands).not.toHaveBeenCalled();
    expect(step.onNext).not.toHaveBeenCalled();
  });

  it('writes the type through the campaign goal and advances when confirmed', async () => {
    const step = props({ session: session('FY27 Ground Robotics') });
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('radio', { name: /^Request a meeting/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Request a meeting' }));

    await waitFor(() => expect(step.onNext).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(step.applyCommands);
    expect(payloadValue(commands, 'SET_GOAL')).toBe('Request a meeting');
    // The name already on the spec is reused verbatim, never regenerated.
    expect(payloadValue(commands, 'SET_TOPIC')).toBe('FY27 Ground Robotics');
  });

  it('supersedes a stale template/format marker when the type actually changes', async () => {
    // Observed live: switching an existing "send update" campaign to Custom
    // left its old template's marker active, and the Context step kept
    // rendering that template's options instead of Custom's Sources panel.
    const withStaleMarkers = session('FY27 Ground Robotics', [
      guidanceRef(`${OUTREACH_TEMPLATE_MARKER}Hearings & markup week-ahead`),
      guidanceRef(`${OUTREACH_FORMAT_MARKER} · Briefing card`),
    ]);
    const step = props({ session: withStaleMarkers, campaignType: 'send_update' });
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('radio', { name: /^Custom/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Custom' }));

    await waitFor(() => expect(step.onNext).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(step.applyCommands);
    const exclude = commands.find((command) => command.type === 'EXCLUDE_CONTEXT_REFS');
    expect(exclude).toBeDefined();
    const refs = (exclude?.payload as { refs: Array<{ contextKey: string }> }).refs;
    expect(refs.map((ref) => ref.contextKey).sort()).toEqual(
      [
        `ctx:${OUTREACH_TEMPLATE_MARKER}Hearings & markup week-ahead`,
        `ctx:${OUTREACH_FORMAT_MARKER} · Briefing card`,
      ].sort(),
    );
  });

  it('writes no exclude command when the type is unchanged, even with old markers present', () => {
    const withStaleMarkers = session('FY27 Ground Robotics', [
      guidanceRef(`${OUTREACH_TEMPLATE_MARKER}Hearings & markup week-ahead`),
    ]);
    const step = props({ session: withStaleMarkers, campaignType: 'send_update' });
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Send update' }));

    expect(step.applyCommands).not.toHaveBeenCalled();
  });

  it('stores only the campaign type when the campaign has no name yet', async () => {
    const step = props({ session: session(null) });
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Send update' }));

    await waitFor(() => expect(step.onNext).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(step.applyCommands);
    expect(commands.map((command) => command.type)).toEqual(['SET_GOAL']);
    expect(payloadValue(commands, 'SET_GOAL')).toBe('Send a client update');
  });

  it('advances without writing a new spec version when the type is unchanged', () => {
    const step = props({ campaignType: 'send_update' });
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Send update' }));

    expect(step.applyCommands).not.toHaveBeenCalled();
    expect(step.onNext).toHaveBeenCalledTimes(1);
  });

  it('is never gated: the primary is live with nothing but the default selected', () => {
    render(<OutreachCampaignTypeStep {...props()} />);

    expect(screen.getByRole('button', { name: 'Continue with Send update' })).toBeEnabled();
  });

  it('disables the tiles and the primary while a command batch is in flight', () => {
    render(<OutreachCampaignTypeStep {...props({ busy: true })} />);

    expect(screen.getByRole('button', { name: 'Continue with Send update' })).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('keeps the user on the step and states the reason when the write fails', async () => {
    const step = props({
      applyCommands: vi.fn(async () => {
        throw new Error('Campaign goal is required.');
      }),
    });
    render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('radio', { name: /^Custom/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Custom' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Campaign goal is required.');
    expect(step.onNext).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /^Custom/ })).toBeChecked();
  });

  it('drops a local pick once the saved type catches up', () => {
    const step = props();
    const { rerender } = render(<OutreachCampaignTypeStep {...step} />);

    fireEvent.click(screen.getByRole('radio', { name: /^Custom/ }));
    expect(screen.getByRole('radio', { name: /^Custom/ })).toBeChecked();

    rerender(<OutreachCampaignTypeStep {...step} campaignType="request_meeting" />);

    expect(screen.getByRole('radio', { name: /^Request a meeting/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Custom/ })).not.toBeChecked();
  });

  describe('started from Capiro Template', () => {
    it('greys out Send update and Custom with a Coming soon tag, leaving Request a meeting live', () => {
      render(<OutreachCampaignTypeStep {...props()} startedFrom="Capiro Template" />);

      expect(screen.getByRole('radio', { name: /^Request a meeting/ })).toBeEnabled();
      expect(screen.getByRole('radio', { name: /^Send update/ })).toBeDisabled();
      expect(screen.getByRole('radio', { name: /^Custom/ })).toBeDisabled();
      expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    });

    it('defaults the selection to Request a meeting instead of Send update', () => {
      render(<OutreachCampaignTypeStep {...props()} startedFrom="Capiro Template" />);

      expect(screen.getByRole('radio', { name: /^Request a meeting/ })).toBeChecked();
    });

    it('cannot select a disabled tile — clicking it does not move the selection', () => {
      render(<OutreachCampaignTypeStep {...props()} startedFrom="Capiro Template" />);

      fireEvent.click(screen.getByRole('radio', { name: /^Send update/ }));

      expect(screen.getByRole('radio', { name: /^Request a meeting/ })).toBeChecked();
      expect(screen.getByRole('radio', { name: /^Send update/ })).not.toBeChecked();
    });

    it('does not disable any tile for Firm Template or a deep link with no startedFrom', () => {
      render(<OutreachCampaignTypeStep {...props()} startedFrom="Firm Template" />);
      for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled();

      const { unmount } = render(<OutreachCampaignTypeStep {...props()} />);
      for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled();
      unmount();
    });
  });
});
