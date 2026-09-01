import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../../pages/clients/clientTypes.js';
import type {
  OutreachV3CampaignSpec,
  OutreachV3Command,
  OutreachV3ResolvedContextRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  outreachBuilderPrimaryLabel,
} from './outreach-campaign-flow.js';
import { OUTREACH_SUBJECT_MARKER } from './outreach-builder-model.js';
import { OutreachNameStep, type OutreachNameStepProps } from './outreach-step-name.js';

/**
 * The Name step is the one place the campaign's subject line is decided, and
 * the prototype's two liberties with it are both refused here: it seeds the
 * field with a hardcoded campaign name, and it labels the field REQUIRED while
 * letting a blank one through. These tests pin both refusals, plus the exact
 * copy the prototype promises and the command batch the step actually writes.
 */

function client(id: string, name: string): Client {
  return {
    id,
    name,
    website: null,
    description: null,
    productDescription: null,
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
    logoS3Key: null,
    logoContentType: null,
    logoUploadedAt: null,
    intakeData: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function guidanceRef(contextKey: string, title: string): OutreachV3ResolvedContextRef {
  return {
    contextKey,
    locator: { source: 'manual', id: contextKey },
    contextClass: 'writing_guidance',
    scope: { kind: 'campaign' },
    title,
    summary: '',
    verificationClass: 'verified',
    sensitivity: 'normal',
    instructionsAllowed: true,
    usableAsEvidence: false,
    usableAsWritingGuidance: true,
    snapshotHash: 'hash-1',
  };
}

function spec(over: Partial<OutreachV3CampaignSpec> = {}): OutreachV3CampaignSpec {
  return {
    schemaVersion: 'outreach_campaign_spec_v1',
    goal: {
      goal: 'Send a client update',
      objective: null,
      topic: null,
      desiredOutcome: null,
      ask: { mode: 'undecided', text: null },
      whyNow: null,
    },
    sponsor: { kind: 'undecided', label: null, clientRefs: [] },
    targeting: {
      criteria: null,
      selectedTargetRefs: [],
      rejectedRecommendationRefs: [],
    },
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
    ...over,
  };
}

function envelope(over: Partial<OutreachV3CampaignSpec> = {}): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Capiro Template', status: 'active' },
    currentStateVersion: 3,
    spec: spec(over),
    specHash: 'spec-hash',
    readiness: {},
    pendingProposalCount: 0,
  };
}

function renderStep(over: Partial<OutreachNameStepProps> = {}) {
  const applyCommands = vi.fn(async (_commands: OutreachV3Command[]): Promise<unknown> => ({}));
  const onNext = vi.fn();
  const toast = vi.fn();
  const props: OutreachNameStepProps = {
    sessionId: 'session-1',
    session: envelope(),
    campaignType: 'send_update',
    busy: false,
    applyCommands,
    toast,
    onNext,
    primaryLabel: outreachBuilderPrimaryLabel('name', 'send_update'),
    clients: [client('11111111-1111-4111-8111-111111111111', 'Overland AI')],
    startedFrom: 'Capiro Template',
    ...over,
  };
  const result = render(<OutreachNameStep {...props} />);
  return { ...result, applyCommands, onNext, toast };
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText(/Campaign name/) as HTMLInputElement;
}

function primary(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Continue to/ }) as HTMLButtonElement;
}

/** Every command of one type from the single batch the step applied. */
function commandsOfType(
  applyCommands: { mock: { calls: unknown[][] } },
  type: string,
): Array<OutreachV3Command<Record<string, unknown>>> {
  const batch = (applyCommands.mock.calls.at(0)?.at(0) ?? []) as Array<
    OutreachV3Command<Record<string, unknown>>
  >;
  return batch.filter((command) => command.type === type);
}

describe('OutreachNameStep', () => {
  it('renders the step copy the prototype promises', () => {
    renderStep();

    // Title and subline are rendered by the builder shell; this step owns the
    // body. Both come from the shared step machine, never an inline string.
    expect(OUTREACH_BUILDER_STEP_TITLES.name).toBe('Name the campaign');
    expect(OUTREACH_BUILDER_STEP_SUBLINES.name).toBe(
      'The campaign name is the subject line recipients see, not an internal label.',
    );
    expect(outreachBuilderPrimaryLabel('name', 'send_update')).toBe(
      'Continue to update template',
    );
    expect(outreachBuilderPrimaryLabel('name', 'request_meeting')).toBe(
      'Continue to request template',
    );

    expect(screen.getByText('REQUIRED')).toBeTruthy();
    // Two OPTIONAL flags now: the sponsor choice and the why-now field.
    expect(screen.getAllByText('OPTIONAL')).toHaveLength(2);
    expect(
      screen.getByText(
        'This is the subject line every recipient sees — not an internal label. Write it the way you want it to land in an inbox.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Who the campaign is sent on behalf of. A client sponsor scopes every later context read to that client; the firm sponsor keeps client-scoped material out entirely.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Every confirmed change creates a new immutable Campaign Spec version.'),
    ).toBeTruthy();
    expect(screen.getByText('Campaign so far')).toBeTruthy();
    expect(
      screen.getByText(
        'Anything not set reads as not set rather than borrowing a neighbouring value.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('What this step does not do')).toBeTruthy();
    expect(
      screen.getByText(
        'No client is required. No target is selected here. No draft is written and nothing is sent.',
      ),
    ).toBeTruthy();
    expect(primary().textContent).toContain('Continue to update template');
  });

  it('shows the prototype placeholder without seeding it as a real campaign name', () => {
    renderStep();

    // The prototype's input opens pre-filled with a mock campaign name equal to
    // its own placeholder. Pre-filling here would write invented prose into the
    // spec's topic and into the subject line of every draft.
    expect(nameInput().value).toBe('');
    expect(nameInput().placeholder).toBe(
      'FY27 Ground Robotics — where the autonomy provision landed',
    );
  });

  it('counts characters with the prototype’s exact (unpluralised) formula', () => {
    renderStep();

    expect(screen.getByText('0 characters')).toBeTruthy();
    fireEvent.change(nameInput(), { target: { value: 'A' } });
    // "1 characters" — the prototype has no singular form and no thresholds.
    expect(screen.getByText('1 characters')).toBeTruthy();
    fireEvent.change(nameInput(), { target: { value: 'Section 215 update' } });
    expect(screen.getByText('18 characters')).toBeTruthy();
  });

  it('disables Continue while the name is empty, unlike the prototype', () => {
    renderStep();

    expect(primary().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect(primary().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: 'Ground robotics briefing' } });
    expect(primary().disabled).toBe(false);
  });

  it('builds the sponsor tiles from the real client list', () => {
    renderStep({
      clients: [
        client('11111111-1111-4111-8111-111111111111', 'Overland AI'),
        client('22222222-2222-4222-8222-222222222222', 'Aperture Defense'),
      ],
    });

    const group = screen.getByRole('radiogroup', { name: /Sponsor/ });
    const tiles = within(group).getAllByRole('radio');
    expect(tiles).toHaveLength(4);
    expect(within(group).getByText('Capiro · firm')).toBeTruthy();
    expect(within(group).getByText('Overland AI')).toBeTruthy();
    expect(within(group).getByText('Aperture Defense')).toBeTruthy();
    expect(within(group).getByText('No sponsor yet')).toBeTruthy();
    expect(
      within(group).getAllByText('Client-sponsored. Scopes every later context read to this client.'),
    ).toHaveLength(2);
  });

  it('offers only the firm and undecided tiles when the firm has no clients', () => {
    renderStep({ clients: [] });

    const group = screen.getByRole('radiogroup', { name: /Sponsor/ });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(within(group).queryByText('Client-sponsored. Scopes every later context read to this client.')).toBeNull();
    // A spec with no sponsor is `undecided`, which is what this tile means.
    expect(
      (within(group).getByRole('radio', { name: /No sponsor yet/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('writes the name to the goal topic and to a subject-line guidance ref', async () => {
    const { applyCommands, onNext } = renderStep();

    fireEvent.change(nameInput(), { target: { value: '  Ground robotics briefing  ' } });
    fireEvent.click(primary());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(applyCommands).toHaveBeenCalledTimes(1);

    expect(commandsOfType(applyCommands, 'SET_TOPIC').at(0)?.payload).toEqual({
      value: 'Ground robotics briefing',
    });
    // The campaign type round-trips through `goal.goal`, so the phrase written
    // here is the canonical one, not prose derived from the campaign name.
    expect(commandsOfType(applyCommands, 'SET_GOAL').at(0)?.payload).toEqual({
      value: 'Send a client update',
    });

    const accepted = commandsOfType(applyCommands, 'ACCEPT_CONTEXT_REFS');
    expect(accepted).toHaveLength(1);
    const selections = accepted.at(0)?.payload.selections as Array<{
      locator: { title: string; text: string };
      contextClass: string;
      scope: { kind: string };
    }>;
    expect(selections).toHaveLength(1);
    expect(selections.at(0)?.locator.title).toBe(OUTREACH_SUBJECT_MARKER);
    expect(selections.at(0)?.locator.text).toContain('Ground robotics briefing');
    expect(selections.at(0)?.contextClass).toBe('writing_guidance');
    expect(selections.at(0)?.scope.kind).toBe('campaign');
  });

  it('replaces the previous subject-line ref instead of stacking a second one', async () => {
    const { applyCommands, onNext } = renderStep({
      session: envelope({
        goal: {
          goal: 'Send a client update',
          objective: null,
          topic: 'Old subject',
          desiredOutcome: null,
          ask: { mode: 'undecided', text: null },
          whyNow: null,
        },
        context: {
          requiredPolicyRefs: [],
          writingGuidanceRefs: [guidanceRef('ctx-old', OUTREACH_SUBJECT_MARKER)],
          campaignFactRefs: [],
          targetSpecificRefs: [],
          groupSafeRefs: [],
          excludedRefs: [],
        },
      }),
    });

    expect(nameInput().value).toBe('Old subject');
    fireEvent.change(nameInput(), { target: { value: 'New subject' } });
    fireEvent.click(primary());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    const excluded = commandsOfType(applyCommands, 'EXCLUDE_CONTEXT_REFS');
    expect(excluded).toHaveLength(1);
    expect(excluded.at(0)?.payload.refs).toEqual([
      { contextKey: 'ctx-old', reason: 'superseded' },
    ]);
    expect(commandsOfType(applyCommands, 'ACCEPT_CONTEXT_REFS')).toHaveLength(1);
  });

  it('does not rewrite the subject-line ref when the name is unchanged', async () => {
    const { applyCommands, onNext } = renderStep({
      session: envelope({
        goal: {
          goal: 'Send a client update',
          objective: null,
          topic: 'Ground robotics briefing',
          desiredOutcome: null,
          ask: { mode: 'undecided', text: null },
          whyNow: null,
        },
        context: {
          requiredPolicyRefs: [],
          writingGuidanceRefs: [guidanceRef('ctx-old', OUTREACH_SUBJECT_MARKER)],
          campaignFactRefs: [],
          targetSpecificRefs: [],
          groupSafeRefs: [],
          excludedRefs: [],
        },
      }),
    });

    fireEvent.click(primary());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(commandsOfType(applyCommands, 'ACCEPT_CONTEXT_REFS')).toHaveLength(0);
    expect(commandsOfType(applyCommands, 'EXCLUDE_CONTEXT_REFS')).toHaveLength(0);
  });

  it('saves the chosen sponsor, and can return the campaign to no sponsor', async () => {
    const chosen = renderStep();
    fireEvent.change(nameInput(), { target: { value: 'Ground robotics briefing' } });
    fireEvent.click(screen.getByRole('radio', { name: /Overland AI/ }));
    fireEvent.click(primary());

    await waitFor(() => expect(chosen.onNext).toHaveBeenCalledTimes(1));
    expect(commandsOfType(chosen.applyCommands, 'SET_SPONSOR_SCOPE').at(0)?.payload).toEqual({
      kind: 'client',
      label: 'Overland AI',
      clientRefs: [{ clientId: '11111111-1111-4111-8111-111111111111' }],
    });

    chosen.unmount();

    // "No sponsor yet" has to be able to undo a saved sponsor, or it is a
    // control that silently does nothing.
    const cleared = renderStep({
      session: envelope({
        goal: {
          goal: 'Send a client update',
          objective: null,
          topic: 'Ground robotics briefing',
          desiredOutcome: null,
          ask: { mode: 'undecided', text: null },
          whyNow: null,
        },
        sponsor: {
          kind: 'client',
          label: 'Overland AI',
          clientRefs: [{ clientId: '11111111-1111-4111-8111-111111111111' }],
        },
      }),
    });
    expect(
      (screen.getByRole('radio', { name: /Overland AI/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /No sponsor yet/ }));
    fireEvent.click(primary());

    await waitFor(() => expect(cleared.onNext).toHaveBeenCalledTimes(1));
    expect(commandsOfType(cleared.applyCommands, 'SET_SPONSOR_SCOPE').at(0)?.payload).toEqual({
      kind: 'undecided',
      label: null,
      clientRefs: [],
    });
  });

  it('reads unset facts as "Not set" and tracks the pending edits', () => {
    renderStep({ campaignType: null, startedFrom: '', clients: [] });

    const aside = screen.getByRole('complementary', { name: 'Campaign so far' });
    // Subject line, Campaign type and Started from are all empty; Sponsor is
    // "No sponsor yet", which is an absence too.
    expect(within(aside).getAllByText('Not set')).toHaveLength(4);

    fireEvent.change(nameInput(), { target: { value: 'Ground robotics briefing' } });
    expect(within(aside).getByText('Ground robotics briefing')).toBeTruthy();
    expect(within(aside).getAllByText('Not set')).toHaveLength(3);

    fireEvent.click(screen.getByRole('radio', { name: /Capiro · firm/ }));
    expect(within(aside).getByText('Capiro · firm')).toBeTruthy();
    expect(within(aside).getAllByText('Not set')).toHaveLength(2);
  });

  it('shows a whitespace-only name as Not set while the counter still counts it', () => {
    renderStep();

    fireEvent.change(nameInput(), { target: { value: '   ' } });
    const aside = screen.getByRole('complementary', { name: 'Campaign so far' });
    expect(within(aside).getAllByText('Not set').length).toBeGreaterThan(0);
    expect(screen.getByText('3 characters')).toBeTruthy();
  });

  it('stays on the step and reports the reason when the batch fails', async () => {
    const { applyCommands, onNext } = renderStep();
    applyCommands.mockRejectedValueOnce(new Error('Version conflict.'));

    fireEvent.change(nameInput(), { target: { value: 'Ground robotics briefing' } });
    fireEvent.click(primary());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Version conflict.'));
    expect(onNext).not.toHaveBeenCalled();
  });

  it('blocks the primary while the shell reports a batch in flight', () => {
    renderStep({
      busy: true,
      session: envelope({
        goal: {
          goal: 'Send a client update',
          objective: null,
          topic: 'Ground robotics briefing',
          desiredOutcome: null,
          ask: { mode: 'undecided', text: null },
          whyNow: null,
        },
      }),
    });

    expect(primary().disabled).toBe(true);
    expect(nameInput().disabled).toBe(true);
  });

  // ── Why now / scheduling window ──────────────────────────────────────────

  function whyNowInput(): HTMLTextAreaElement {
    return screen.getByLabelText(/Why now \/ scheduling window/) as HTMLTextAreaElement;
  }

  it('renders the why-now field empty when the spec holds none', () => {
    renderStep();
    expect(whyNowInput().value).toBe('');
  });

  it('seeds the why-now field from the saved spec value', () => {
    renderStep({
      session: envelope({
        goal: {
          goal: 'Request a meeting',
          objective: null,
          topic: 'Ground robotics briefing',
          desiredOutcome: null,
          ask: { mode: 'undecided', text: null },
          whyNow: 'We will be in Washington the week of October 6',
        },
      }),
    });
    expect(whyNowInput().value).toBe('We will be in Washington the week of October 6');
  });

  it('writes a filled why-now into the goal batch instead of the derived default', async () => {
    const { applyCommands, onNext } = renderStep({ campaignType: 'request_meeting' });

    fireEvent.change(nameInput(), { target: { value: 'Ground robotics briefing' } });
    fireEvent.change(whyNowInput(), {
      target: { value: '  Ahead of the FY28 posture hearings  ' },
    });
    fireEvent.click(primary());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(commandsOfType(applyCommands, 'SET_WHY_NOW').at(0)?.payload).toEqual({
      value: 'Ahead of the FY28 posture hearings',
    });
  });

  it('clears the why-now (null) when the user empties a previously saved one', async () => {
    const { applyCommands, onNext } = renderStep({
      campaignType: 'request_meeting',
      session: envelope({
        goal: {
          goal: 'Request a meeting',
          objective: null,
          topic: 'Ground robotics briefing',
          desiredOutcome: null,
          ask: { mode: 'undecided', text: null },
          whyNow: 'We will be in Washington the week of October 6',
        },
      }),
    });

    fireEvent.change(whyNowInput(), { target: { value: '' } });
    fireEvent.click(primary());

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(commandsOfType(applyCommands, 'SET_WHY_NOW').at(0)?.payload).toEqual({ value: null });
  });
});
