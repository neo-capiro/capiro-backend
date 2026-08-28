import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  OutreachV3Command,
  OutreachV3ResolvedContextRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  OUTREACH_FORMAT_SKIP_NOTE,
  outreachBuilderPrimaryLabel,
} from './outreach-campaign-flow.js';
import type { OutreachBuilderStepCommon } from './outreach-builder-model.js';
import { contentTemplateById } from './outreach-v3-content-templates.js';
import { OutreachTemplateStep } from './outreach-step-template.js';

/**
 * The Template step's job is to make a real structure decision on the Campaign
 * Spec. The assertions that matter are therefore about the COMMANDS a click
 * emits — a highlighted row that sent nothing is exactly the prototype's
 * fabrication this port exists to remove.
 */

function guidanceRef(title: string, contextKey: string): OutreachV3ResolvedContextRef {
  return {
    contextKey,
    locator: { source: 'manual', id: contextKey, title },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
    title,
    summary: '',
    verificationClass: 'unverified',
    sensitivity: 'normal',
    instructionsAllowed: true,
    usableAsEvidence: false,
    usableAsWritingGuidance: true,
    snapshotHash: 'hash',
  } as OutreachV3ResolvedContextRef;
}

function session(over: {
  goal?: string | null;
  writingGuidanceRefs?: OutreachV3ResolvedContextRef[];
  contentSkeleton?: unknown;
} = {}): OutreachV3SessionEnvelope {
  const spec = {
    schemaVersion: 'outreach_campaign_spec_v1',
    goal: {
      goal: over.goal === undefined ? 'Send a client update' : over.goal,
      objective: null,
      topic: 'FY27 ground robotics',
      desiredOutcome: null,
      ask: { mode: 'undecided', text: null },
      whyNow: null,
    },
    sponsor: { kind: 'undecided', label: null, clientRefs: [] },
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
    strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
    // The server carries contentSkeleton on the spec; the browser contract type
    // has not declared it yet, so the fixture attaches it the same way the step
    // reads it.
    ...(over.contentSkeleton ? { contentSkeleton: over.contentSkeleton } : {}),
  };
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 1,
    specHash: 'hash-1',
    pendingProposalCount: 0,
    readiness: { blockers: [] },
    spec: spec as unknown as OutreachV3SessionEnvelope['spec'],
  };
}

function renderStep(over: Partial<OutreachBuilderStepCommon> = {}) {
  const applyCommands = vi.fn(async () => undefined);
  const toast = vi.fn();
  const onNext = vi.fn();
  const props: OutreachBuilderStepCommon = {
    sessionId: 'session-1',
    session: session(),
    campaignType: 'send_update',
    busy: false,
    applyCommands,
    toast,
    onNext,
    primaryLabel: outreachBuilderPrimaryLabel('update', 'send_update'),
    ...over,
  };
  const result = render(<OutreachTemplateStep {...props} />);
  return { ...result, applyCommands, toast, onNext, props };
}

function commandsFrom(applyCommands: ReturnType<typeof vi.fn>): OutreachV3Command[] {
  const call = applyCommands.mock.calls.at(0);
  return (call?.[0] ?? []) as OutreachV3Command[];
}

describe('OutreachTemplateStep', () => {
  it('carries the prototype’s step copy — title, subline and primary label', () => {
    expect(OUTREACH_BUILDER_STEP_TITLES.update).toBe('Choose a template');
    expect(OUTREACH_BUILDER_STEP_SUBLINES.update).toBe(
      'Pick the structure Meri should follow. Preview a sample before choosing — the sample is a reference for structure and tone only, never data that gets copied into your draft.',
    );
    renderStep();
    expect(
      screen.getByRole('button', { name: 'Continue to format' }),
    ).toBeInTheDocument();
  });

  it('lists the real content templates for the campaign type, with the honest scope label', () => {
    renderStep();
    expect(screen.getByText('Update template')).toBeInTheDocument();
    expect(screen.getByText('Hearings & markup week-ahead')).toBeInTheDocument();
    expect(screen.getByText('Relationship / meeting week-in-review')).toBeInTheDocument();
    // Six real send-update templates, none of them personal: they all ship with
    // the product, so every row reads "Capiro" rather than inventing an
    // "Only me" distinction the data does not carry.
    expect(screen.getAllByText('Capiro')).toHaveLength(6);
    expect(screen.queryByText('Only me')).not.toBeInTheDocument();
  });

  it('shows the meeting-request set and the format-skip note for a meeting request', () => {
    renderStep({
      campaignType: 'request_meeting',
      session: session({ goal: 'Request a meeting' }),
      primaryLabel: outreachBuilderPrimaryLabel('update', 'request_meeting'),
    });
    expect(screen.getByText('Request template')).toBeInTheDocument();
    expect(screen.getByText('Briefing meeting request')).toBeInTheDocument();
    expect(screen.getByText(OUTREACH_FORMAT_SKIP_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to targets' })).toBeInTheDocument();
  });

  it('does not show the format-skip note when the campaign type keeps the Format step', () => {
    renderStep();
    expect(screen.queryByText(OUTREACH_FORMAT_SKIP_NOTE)).not.toBeInTheDocument();
  });

  it('renders the Custom empty explainer verbatim and keeps the primary button working', () => {
    const { onNext } = renderStep({
      campaignType: 'custom',
      session: session({ goal: 'Custom campaign' }),
    });
    expect(
      screen.getByText(
        'Custom campaigns have no fixed structure. Meri asks for the purpose in prose, then writes from your brief and the context you select.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Preview sample draft/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to format' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('opens the editor for a Custom campaign, which the prototype leaves as a dead control', () => {
    renderStep({ campaignType: 'custom', session: session({ goal: 'Custom campaign' }) });
    fireEvent.click(screen.getByRole('button', { name: /Create one from scratch/ }));
    expect(screen.getByText('Template structure')).toBeInTheDocument();
    expect(screen.getByLabelText('Body')).toBeInTheDocument();
  });

  it('applies a skeleton-less template as SET_CONTENT_SKELETON(null) plus its sample as guidance', async () => {
    const { applyCommands } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Hearings & markup week-ahead/ }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(applyCommands);
    expect(commands.map((command) => command.type)).toEqual([
      'SET_CONTENT_SKELETON',
      'ACCEPT_CONTEXT_REFS',
    ]);
    expect(commands.at(0)?.payload).toEqual({ value: null });
    const accept = commands.at(1)?.payload as { selections: Array<{ locator: { title: string } }> };
    expect(accept.selections.at(0)?.locator.title).toBe(
      'Update template — Hearings & markup week-ahead',
    );
  });

  it('applies a skeleton template as the real skeleton and sends no competing guidance', async () => {
    const { applyCommands } = renderStep({
      campaignType: 'request_meeting',
      session: session({ goal: 'Request a meeting' }),
      primaryLabel: outreachBuilderPrimaryLabel('update', 'request_meeting'),
    });
    fireEvent.click(screen.getByRole('button', { name: /Briefing meeting request/ }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(applyCommands);
    expect(commands.map((command) => command.type)).toEqual(['SET_CONTENT_SKELETON']);
    expect(commands.at(0)?.payload).toEqual({
      value: contentTemplateById('meeting_request_standard')?.skeleton,
    });
  });

  it('supersedes the previous template’s guidance when a different template is picked', async () => {
    const { applyCommands } = renderStep({
      session: session({
        writingGuidanceRefs: [
          guidanceRef('Update template — Hearings & markup week-ahead', 'ctx-old'),
        ],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /Funding opportunity match digest/ }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(applyCommands);
    expect(commands.map((command) => command.type)).toEqual([
      'SET_CONTENT_SKELETON',
      'ACCEPT_CONTEXT_REFS',
      'EXCLUDE_CONTEXT_REFS',
    ]);
    expect(commands.at(2)?.payload).toEqual({
      refs: [{ contextKey: 'ctx-old', reason: 'superseded' }],
    });
  });

  it('reads the saved choice back from the spec and previews that template’s sample', () => {
    renderStep({
      session: session({
        writingGuidanceRefs: [
          guidanceRef('Update template — Federal awards & primes roll-up', 'ctx-1'),
        ],
      }),
    });
    const row = screen.getByRole('button', { name: /Federal awards & primes roll-up/ });
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText('Preview sample draft · Federal awards & primes roll-up'),
    ).toBeInTheDocument();
    const template = contentTemplateById('federal_awards_rollup');
    expect(screen.getByText(template!.sampleSubject)).toBeInTheDocument();
  });

  it('states that nothing is chosen instead of pre-selecting the first row', () => {
    renderStep();
    expect(
      screen.getByRole('button', { name: /Hearings & markup week-ahead/ }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Choose a template to preview its sample draft.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit this template' })).not.toBeInTheDocument();
  });

  it('always shows the structure-and-tone disclaimer beside the preview', () => {
    renderStep();
    expect(
      screen.getByText(
        'Structure and tone reference only. Nothing in the sample is copied into your draft — Meri writes inside this structure using the context you select.',
      ),
    ).toBeInTheDocument();
  });

  it('refuses to save an authored structure until it has a name and no validation issues', () => {
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Create one from scratch/ }));
    const save = screen.getByRole('button', { name: 'Save as my template' });
    // The starter draft is valid, so only the empty "Save as" name blocks it.
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Save as'), { target: { value: 'My structure' } });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '' } });
    expect(screen.getByText('The template body cannot be empty.')).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it('saves an authored structure to THIS campaign and says so, rather than to a library', async () => {
    const { applyCommands, toast } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Create one from scratch/ }));
    fireEvent.change(screen.getByLabelText('Save as'), { target: { value: 'My structure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as my template' }));
    await waitFor(() => expect(applyCommands).toHaveBeenCalledTimes(1));
    const commands = commandsFrom(applyCommands);
    expect(commands.map((command) => command.type)).toEqual(['SET_CONTENT_SKELETON']);
    const payload = commands.at(0)?.payload as { value: { slots: unknown[] } };
    expect(payload.value.slots.length).toBeGreaterThan(0);
    expect(toast).toHaveBeenCalledWith('Template structure applied to this campaign');
  });

  it('shows an authored skeleton the spec already carries as its own "This campaign" row', () => {
    renderStep({
      session: session({
        contentSkeleton: {
          subject: 'Quarterly note: {{topic}}',
          body: 'Hello,\n\n{{topic}}',
          slots: [
            { key: 'topic', label: 'Topic', instruction: 'The topic.', required: true },
          ],
        },
      }),
    });
    const row = screen.getByRole('button', { name: /Your own structure/ });
    expect(row).toHaveAttribute('aria-pressed', 'true');
    expect(within(row).getByText('This campaign')).toBeInTheDocument();
    // Previewed through the same collapsing the server's assembler does.
    expect(screen.getByText('Quarterly note: [Topic]')).toBeInTheDocument();
  });

  it('seeds the editor from the selected template and cancels back to the read view', () => {
    renderStep({
      session: session({
        writingGuidanceRefs: [
          guidanceRef('Update template — Curated defense top-lines', 'ctx-1'),
        ],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit this template' }));
    expect(screen.getByLabelText('Save as')).toHaveValue('Curated defense top-lines (my version)');
    expect(screen.getByLabelText('Subject')).toHaveValue(
      contentTemplateById('defense_toplines')!.sampleSubject,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Edit this template' })).toBeInTheDocument();
  });

  it('adds a section, places its token, and removes it again', () => {
    renderStep();
    fireEvent.click(screen.getByRole('button', { name: /Create one from scratch/ }));
    fireEvent.change(screen.getByLabelText('New section name'), {
      target: { value: 'Why this matters' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(screen.getByText('{{why_this_matters}}')).toBeInTheDocument();
    const body = screen.getByLabelText('Body') as HTMLTextAreaElement;
    expect(body.value).toContain('{{why_this_matters}}');
    fireEvent.click(screen.getByRole('button', { name: 'Remove section why_this_matters' }));
    expect(screen.queryByText('{{why_this_matters}}')).not.toBeInTheDocument();
  });

  it('explains that the type comes first when the campaign has no type yet', () => {
    renderStep({ campaignType: null, session: session({ goal: null }) });
    expect(
      screen.getByText(
        'Choose a campaign type first. The set of templates depends on it, so there is nothing to pick from yet.',
      ),
    ).toBeInTheDocument();
  });

  it('disables every action while a command batch is in flight', () => {
    renderStep({ busy: true });
    expect(screen.getByRole('button', { name: 'Continue to format' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Create one from scratch/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Hearings & markup week-ahead/ })).toBeDisabled();
  });

  it('surfaces a failed apply instead of leaving the row looking chosen', async () => {
    const applyCommands = vi.fn(async () => {
      throw new Error('The spec version moved on.');
    });
    renderStep({ applyCommands });
    fireEvent.click(screen.getByRole('button', { name: /Hearings & markup week-ahead/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The spec version moved on.');
  });
});
