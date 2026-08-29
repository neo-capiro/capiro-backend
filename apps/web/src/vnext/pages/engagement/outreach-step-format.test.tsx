import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  OutreachV3Command,
  OutreachV3ResolvedContextRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import { OutreachFormatStep } from './outreach-step-format.js';
import { OUTREACH_FORMAT_PREVIEW_EMPTY_NOTE } from './outreach-format-preview.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  OUTREACH_FORMAT_NOTE,
  outreachBuilderPrimaryLabel,
} from './outreach-campaign-flow.js';
import {
  OUTREACH_FORMAT_MARKER,
  OUTREACH_UNWIRED_CONTROLS,
  type OutreachBuilderStepCommon,
} from './outreach-builder-model.js';

function guidanceRef(title: string, contextKey: string): OutreachV3ResolvedContextRef {
  return {
    contextKey,
    locator: { source: 'manual', id: contextKey, title },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
    title,
    summary: '',
    verificationClass: 'manual',
    sensitivity: 'internal',
    instructionsAllowed: true,
    usableAsEvidence: false,
    usableAsWritingGuidance: true,
    snapshotHash: `hash-${contextKey}`,
  };
}

const SKELETON = {
  subject: 'Week ahead · 6 on your watch',
  body: [
    'Bottom line',
    '{{bottom_line}}',
    '',
    'HOUSE',
    'Mon Aug 25 · 10:00 ET · HASC Tactical Air & Land',
  ].join('\n'),
  slots: [
    {
      key: 'bottom_line',
      label: 'Bottom line',
      instruction: 'One sentence on what moved.',
      required: true,
    },
  ],
};

function session(
  over: {
    writingGuidanceRefs?: OutreachV3ResolvedContextRef[];
    topic?: string | null;
    contentSkeleton?: unknown;
  } = {},
): OutreachV3SessionEnvelope {
  const envelope: OutreachV3SessionEnvelope = {
    session: { id: 'session-1', title: 'Campaign', status: 'active' },
    currentStateVersion: 3,
    specHash: 'hash-1',
    pendingProposalCount: 0,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: false,
      targetsReady: false,
      deliveryReady: false,
      contextReady: false,
      contextEvidenceReady: false,
      strategyReady: false,
      blockers: [],
    },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Send a client update',
        objective: null,
        topic: over.topic === undefined ? 'FY27 Ground Robotics' : over.topic,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'firm', label: 'Capiro · firm', clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: over.writingGuidanceRefs ?? [],
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
  if (over.contentSkeleton !== undefined) {
    // SET_CONTENT_SKELETON writes a field the contract type does not declare —
    // the component reads it structurally, so the fixture attaches it the same
    // way the server sends it.
    (envelope.spec as unknown as Record<string, unknown>)['contentSkeleton'] = over.contentSkeleton;
  }
  return envelope;
}

function renderStep(over: Partial<OutreachBuilderStepCommon> = {}) {
  const batches: OutreachV3Command[][] = [];
  const applyCommands = vi.fn(async (commands: OutreachV3Command[]) => {
    batches.push(commands);
    return undefined;
  });
  const onNext = vi.fn();
  const props: OutreachBuilderStepCommon = {
    sessionId: 'session-1',
    session: session(),
    campaignType: 'send_update',
    busy: false,
    applyCommands,
    toast: vi.fn(),
    onNext,
    primaryLabel: outreachBuilderPrimaryLabel('format', 'send_update'),
    ...over,
  };
  return { ...render(<OutreachFormatStep {...props} />), applyCommands, batches, onNext, props };
}

describe('OutreachFormatStep', () => {
  it('promises the prototype’s copy for this step', () => {
    // Title and subline are rendered by the builder shell from these constants;
    // pinning them here keeps the step's promise verbatim wherever it is drawn.
    expect(OUTREACH_BUILDER_STEP_TITLES.format).toBe('Choose the email format');
    expect(OUTREACH_BUILDER_STEP_SUBLINES.format).toBe(
      'Presentation only. The words come from the template you picked — format changes how they are laid out.',
    );
    renderStep();
    expect(screen.getByRole('button', { name: 'Continue to targets' })).toBeInTheDocument();
    expect(screen.getByText(OUTREACH_FORMAT_NOTE)).toBeInTheDocument();
  });

  it('offers the four formats, badging only the one that is safest by construction', () => {
    renderStep();
    const tiles = screen.getAllByRole('radio');
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      expect.stringContaining('Standard email'),
      expect.stringContaining('Briefing card'),
      expect.stringContaining('Status table'),
      expect.stringContaining('Timeline update'),
    ]);
    expect(
      screen.getByText(
        'Plain text in the recipient’s mailbox font. Nothing to strip, nothing to render — the safest option for Hill offices.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Safest')).toHaveLength(1);
    // No recommendation signal exists in this codebase, so none is claimed.
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('says plainly that the choice steers generation rather than rendering it', () => {
    renderStep();
    const reality = OUTREACH_UNWIRED_CONTROLS.find((row) => row.control === 'Email format')?.reality;
    expect(reality).toBeDefined();
    expect(screen.getByText(reality as string)).toBeInTheDocument();
  });

  it('defaults to standard email when the spec carries no format', () => {
    renderStep();
    expect(screen.getByRole('radio', { name: /Standard email/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Preview · Standard email')).toBeInTheDocument();
  });

  it('reads the stored format back off the spec and previews with it', () => {
    renderStep({
      session: session({
        writingGuidanceRefs: [guidanceRef(`${OUTREACH_FORMAT_MARKER} · Status table`, 'ctx-1')],
        contentSkeleton: SKELETON,
      }),
    });
    expect(screen.getByRole('radio', { name: /Status table/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText('Preview · Status table')).toBeInTheDocument();
    // The status-table chrome, not the plain one.
    expect(screen.getByText('Item')).toBeInTheDocument();
  });

  it('stores a chosen format as campaign writing guidance', async () => {
    const { applyCommands, batches } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: /Briefing card/ }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const commands = batches[0] ?? [];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.type).toBe('ACCEPT_CONTEXT_REFS');
    const payload = commands[0]?.payload as {
      selections: Array<{ locator: { title: string }; contextClass: string; scope: { kind: string } }>;
    };
    expect(payload.selections[0]?.locator.title).toBe(`${OUTREACH_FORMAT_MARKER} · Briefing card`);
    expect(payload.selections[0]?.contextClass).toBe('writing_guidance');
    expect(payload.selections[0]?.scope.kind).toBe('campaign');
  });

  it('supersedes the previous format marker in the same batch', async () => {
    const { applyCommands, batches } = renderStep({
      session: session({
        writingGuidanceRefs: [
          guidanceRef(`${OUTREACH_FORMAT_MARKER} · Briefing card`, 'ctx-old'),
          guidanceRef('Campaign subject line', 'ctx-subject'),
        ],
      }),
    });
    fireEvent.click(screen.getByRole('radio', { name: /Timeline update/ }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const commands = batches[0] ?? [];
    expect(commands.map((command) => command.type)).toEqual([
      'ACCEPT_CONTEXT_REFS',
      'EXCLUDE_CONTEXT_REFS',
    ]);
    // Only the format marker is superseded — the subject-line ref is untouched.
    expect(commands[1]?.payload).toEqual({
      refs: [{ contextKey: 'ctx-old', reason: 'superseded' }],
    });
  });

  it('does not rewrite the spec when the stored format is clicked again', () => {
    const { applyCommands } = renderStep({
      session: session({
        writingGuidanceRefs: [guidanceRef(`${OUTREACH_FORMAT_MARKER} · Status table`, 'ctx-1')],
      }),
    });
    fireEvent.click(screen.getByRole('radio', { name: /Status table/ }));
    expect(applyCommands).not.toHaveBeenCalled();
  });

  it('previews the campaign’s own letter, with slot regions labelled', () => {
    renderStep({ session: session({ contentSkeleton: SKELETON }) });
    expect(screen.getByText('Week ahead · 6 on your watch')).toBeInTheDocument();
    expect(screen.getByText(/\[Bottom line\]/)).toBeInTheDocument();
  });

  it('falls back to the campaign name as the subject line when the skeleton has none', () => {
    renderStep({
      session: session({
        contentSkeleton: { subject: '', body: 'Dear staff,', slots: [] },
      }),
    });
    expect(screen.getByText('FY27 Ground Robotics')).toBeInTheDocument();
  });

  it('shows the honest empty preview when the campaign has no letter yet', () => {
    renderStep();
    expect(screen.getByText(OUTREACH_FORMAT_PREVIEW_EMPTY_NOTE)).toBeInTheDocument();
  });

  it('advances on the primary button and blocks every control while a batch is in flight', () => {
    const { onNext } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to targets' }));
    expect(onNext).toHaveBeenCalledTimes(1);

    // RTL's returned queries are bound to document.body, so scope to this
    // second render's own container rather than the first one's tiles.
    const busy = within(renderStep({ busy: true }).container);
    expect(busy.getAllByRole('radio').every((tile) => (tile as HTMLButtonElement).disabled)).toBe(
      true,
    );
    expect(busy.getByRole('button', { name: 'Continue to targets' })).toBeDisabled();
  });
});
