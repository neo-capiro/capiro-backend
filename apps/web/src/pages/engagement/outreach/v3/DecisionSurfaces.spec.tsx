import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CapabilityResult,
  OutreachV3SessionEnvelope,
  OutreachV3StrategyData,
} from './contracts.js';
import { DecisionSurfaces, type DecisionSurfacesProps } from './DecisionSurfaces.js';

/**
 * Covers the real, LIVE Step 3 Delivery surface. `CurrentDecisionSurface.tsx`
 * (the router VNextOutreachWorkspace actually uses) only special-cases
 * goal/sponsor/targets/context — delivery, strategy, and ready_for_generation
 * all fall through to this file's own `DecisionSurfaces` component, which
 * renders its OWN internal `DeliverySurface`, not the separately extracted
 * (and separately "accepted"-contract-tested, but never wired into
 * CurrentDecisionSurface) DeliveryDecisionSurface.tsx. See the phase report
 * for the full trace — item 8's fixes landed here, not in that file.
 */
function session(overrides: Partial<OutreachV3SessionEnvelope['spec']['delivery']> = {}): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Ground Robotics', status: 'active' },
    currentStateVersion: 4,
    specHash: 'hash-4',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: false,
      blockers: ['DELIVERY_UNDECIDED'],
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
        criteria: null,
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'undecided', personalization: 'undecided', ...overrides },
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

/** The goal stage with nothing captured yet — the state the live walkthrough hit. */
function emptyGoalSession(): OutreachV3SessionEnvelope {
  const base = session();
  return {
    ...base,
    spec: {
      ...base.spec,
      goal: {
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
    },
  };
}

function strategyResult(
  overrides: Partial<OutreachV3StrategyData & Record<string, unknown>> = {},
): CapabilityResult<OutreachV3StrategyData> {
  return {
    capability: 'recommend_outreach_strategy',
    schemaVersion: 1,
    data: {
      campaignAngle: null,
      tone: 'Direct',
      length: 'short',
      rationale: [
        'Separate delivery keeps every target independently reviewable.',
        'No shared-thread reply-all risk with this audience size.',
      ],
      warnings: [],
      recommendedPattern: 'uniform_separate',
      recommendedPersonalization: 'light',
      ...overrides,
    } as OutreachV3StrategyData & Record<string, unknown>,
    provenance: [],
  } as CapabilityResult<OutreachV3StrategyData>;
}

function props(overrides: Partial<DecisionSurfacesProps> = {}): DecisionSurfacesProps {
  return {
    session: session(),
    stage: 'delivery',
    clients: [],
    selectedClientId: null,
    busy: false,
    applyCommands: vi.fn(async () => undefined),
    pendingProposals: [],
    proposalBusy: false,
    applyProposal: vi.fn(async () => undefined),
    rejectProposal: vi.fn(async () => undefined),
    searchTargets: vi.fn(async () => undefined),
    targetCandidates: [],
    targetSearchPending: false,
    targetSearchError: null,
    getTargetProfile: vi.fn(async () => undefined),
    targetProfile: undefined,
    targetProfilePending: false,
    coverage: undefined,
    coveragePending: false,
    searchContext: vi.fn(async () => undefined),
    contextCandidates: [],
    contextSearchPending: false,
    contextSearchError: null,
    contextReview: undefined,
    contextReviewPending: false,
    contextReviewError: null,
    strategy: undefined,
    strategyPending: false,
    strategyError: null,
    onFinish: vi.fn(),
    ...overrides,
  };
}

describe('DecisionSurfaces — delivery stage (item 8)', () => {
  it('labels the uniform_separate card "Same message separate", not "Uniform separate"', () => {
    render(<DecisionSurfaces {...props()} />);
    expect(screen.getByRole('button', { name: /Same message separate/i })).toBeInTheDocument();
    expect(screen.queryByText('Uniform separate')).not.toBeInTheDocument();
  });

  it('renders the mandated warning bar on the Shared thread card only', () => {
    const { container } = render(<DecisionSurfaces {...props()} />);
    const cards = screen.getAllByRole('button', { name: /separate|Shared thread/i });
    const sharedThreadCard = screen.getByRole('button', { name: /Shared thread/i });
    expect(sharedThreadCard.querySelector('.ov3-choice-card__warning-bar')).not.toBeNull();
    const otherCards = cards.filter((card) => card !== sharedThreadCard);
    for (const card of otherCards) {
      expect(card.querySelector('.ov3-choice-card__warning-bar')).toBeNull();
    }
    // Exactly one bar in the whole panel — the card-level fix, not a
    // page-wide decoration.
    expect(container.querySelectorAll('.ov3-choice-card__warning-bar')).toHaveLength(1);
  });

  it('renders the real strategy rationale as consequence-chip pills, not a hardcoded default', () => {
    render(<DecisionSurfaces {...props({ strategy: strategyResult() })} />);

    // The recommendation heading reflects the real recommended pattern
    // (using the corrected display title), not the static
    // "Personalized separate · light" placeholder.
    expect(screen.getByRole('heading', { name: 'Same message separate' })).toBeInTheDocument();

    const chip = screen.getByText('Separate delivery keeps every target independently reviewable.');
    expect(chip.className).toContain('eng-pill');
    expect(chip.className).toContain('eng-pill--navy');
    expect(chip.querySelector('.eng-pill__dot')).not.toBeNull();
    expect(
      screen.getByText('No shared-thread reply-all risk with this audience size.'),
    ).toBeInTheDocument();
  });

  it('falls back to the static default heading and shows no chips when strategy has not loaded', () => {
    render(<DecisionSurfaces {...props()} />);
    expect(screen.getByRole('heading', { name: 'Personalized separate · light' })).toBeInTheDocument();
    expect(document.querySelector('.ov3-consequence-chips')).toBeNull();
  });

  it('surfaces a strategy fetch error, which previously had nowhere to render', () => {
    render(<DecisionSurfaces {...props({ strategyError: 'The recommendation could not load.' })} />);
    expect(screen.getByText('The recommendation could not load.')).toBeInTheDocument();
  });

  it('still commits the delivery pattern and personalization batch unchanged', () => {
    const applyCommands = vi.fn(async () => undefined);
    render(<DecisionSurfaces {...props({ applyCommands })} />);

    fireEvent.click(screen.getByRole('button', { name: /Same message separate/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' }));

    expect(applyCommands).toHaveBeenCalledWith([
      { type: 'SET_DELIVERY_PATTERN', schemaVersion: 1, payload: { value: 'uniform_separate' } },
      { type: 'SET_PERSONALIZATION', schemaVersion: 1, payload: { value: 'light' } },
    ]);
  });

  /**
   * The row used to read a hardcoded "Not enabled in Phase 6", which is false:
   * drafting is enabled and every gate reads the generation plan's `eligible`.
   * The only part of that plan this stage owns is the delivery pair, so the row
   * now tracks the live selection.
   */
  it('derives Draft authority from the live delivery selection', () => {
    render(<DecisionSurfaces {...props()} />);
    expect(screen.queryByText('Not enabled in Phase 6')).not.toBeInTheDocument();
    expect(screen.getByText('Blocked until delivery is set')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Shared thread/i }));
    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    // The one pairing buildOutreachV3GenerationPlan blocks outright.
    expect(screen.getByText('Blocked by shared thread + high')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(screen.getByText('Not blocked by this selection')).toBeInTheDocument();
  });

  it('describes the pattern its heading names instead of always claiming independent review', () => {
    render(
      <DecisionSurfaces
        {...props({ strategy: strategyResult({ recommendedPattern: 'shared_thread' }) })}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Shared thread' })).toBeInTheDocument();
    expect(
      screen.getByText(/Every recipient sees the others and can reply to all of them/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/keeps target scope independently reviewable/),
    ).not.toBeInTheDocument();
  });
});

/**
 * Placeholder exemplars used to read as real, plausible campaign copy, so a form
 * of empty required fields looked filled until submit refused it.
 */
describe('DecisionSurfaces — goal stage example text and required-but-empty state', () => {
  it('marks exemplars as examples and required-but-empty fields as unfilled', () => {
    render(<DecisionSurfaces {...props({ stage: 'goal', session: emptyGoalSession() })} />);

    const goal = screen.getByLabelText(/^Campaign goal/i) as HTMLInputElement;
    expect(goal.value).toBe('');
    expect(goal.placeholder).toBe('e.g. Protect FY27 Ground Robotics funding');
    expect(goal.getAttribute('aria-required')).toBe('true');
    expect(goal.closest('.ov3-field')?.className).toContain('is-unfilled');

    // Objective is required by goalCommands, so the surface must say so too.
    expect(screen.getByLabelText(/^Objective/i).closest('.ov3-field')?.className).toContain(
      'is-unfilled',
    );
    // Optional fields keep their exemplar but claim no required state either way.
    const whyNow = screen.getByLabelText(/^Why now/i);
    expect(whyNow.closest('.ov3-field')?.className).toBe('ov3-field');
    expect(whyNow.getAttribute('aria-required')).toBeNull();

    fireEvent.change(goal, { target: { value: 'Protect the FY27 mark' } });
    expect(goal.closest('.ov3-field')?.className).toContain('is-filled');
    expect(goal.closest('.ov3-field')?.className).not.toContain('is-unfilled');
  });
});
