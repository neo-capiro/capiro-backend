import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutreachReviewStep, type OutreachReviewStepProps } from './outreach-step-review.js';
import {
  OUTREACH_BUILDER_STEP_SUBLINES,
  OUTREACH_BUILDER_STEP_TITLES,
  outreachBuilderPrimaryLabel,
} from './outreach-campaign-flow.js';
import type {
  OutreachV3Command,
  OutreachV3ResolvedContextRef,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';

/**
 * Step 7 of the campaign builder — the only step that authorises anything.
 *
 * Its load-bearing properties: a personal note is written as a real
 * target-scoped context ref (so the header's "no one else's" promise is
 * enforceable rather than decorative); the generation request key is derived
 * from the approval hash, never from a random id; and an approval or a
 * generation response that is not unambiguously successful never advances to
 * Drafts.
 */

const { postCalls, postResponses, api } = vi.hoisted(() => {
  const postCalls: Array<{ url: string; body?: unknown }> = [];
  const postResponses: { approval: unknown; generation: unknown } = {
    approval: { approval: { approvalHash: 'approval-hash-1' } },
    generation: { jobId: 'job-1', deduped: false, complete: false, remaining: 2 },
  };
  const api = {
    get: vi.fn(async () => ({ data: null })),
    post: vi.fn(async (url: string, body?: unknown) => {
      postCalls.push({ url, body });
      if (url.includes('/generation/review-packet-approval')) {
        return { data: postResponses.approval };
      }
      if (url.includes('/generation/full')) return { data: postResponses.generation };
      return { data: {} };
    }),
  };
  return { postCalls, postResponses, api };
});

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => api }));

function target(over: Partial<OutreachV3ResolvedTargetRef> = {}): OutreachV3ResolvedTargetRef {
  return {
    targetKey: 'directory_member:member-1',
    locator: { source: 'directory_member', id: 'member-1' },
    displayName: 'Rep. Jane Smith',
    title: 'Ranking Member',
    organization: '2245 Rayburn',
    email: 'jane.smith@mail.house.gov',
    clientId: null,
    roleStatus: 'current',
    snapshotHash: 'snap-1',
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'CA',
      district: '12',
      committees: [],
      issueAreas: [],
    },
    ...over,
  };
}

function contextRef(over: Partial<OutreachV3ResolvedContextRef> = {}): OutreachV3ResolvedContextRef {
  return {
    contextKey: 'ctx-1',
    locator: { source: 'manual', id: 'loc-1' },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
    title: 'A fact',
    summary: 'A fact summary.',
    verificationClass: 'user_supplied',
    sensitivity: 'normal',
    instructionsAllowed: false,
    usableAsEvidence: true,
    usableAsWritingGuidance: false,
    snapshotHash: 'snap-ctx-1',
    ...over,
  };
}

/** A saved personal note, in exactly the shape `targetNoteContextSelection` writes. */
function noteRef(targetKey: string, name: string, note: string): OutreachV3ResolvedContextRef {
  return contextRef({
    contextKey: `ctx-note-${targetKey}`,
    contextClass: 'target_specific',
    scope: { kind: 'target', targetKey },
    title: `Personal note — ${name}`,
    summary: `Personal note for ${name}. Apply this note only to this recipient’s draft: ${note}`,
  });
}

function session(over: {
  topic?: string | null;
  targets?: OutreachV3ResolvedTargetRef[];
  campaignFactRefs?: OutreachV3ResolvedContextRef[];
  writingGuidanceRefs?: OutreachV3ResolvedContextRef[];
  targetSpecificRefs?: OutreachV3ResolvedContextRef[];
} = {}): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 4,
    specHash: 'hash-1',
    pendingProposalCount: 0,
    readiness: {},
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: 'Send a client update',
        objective: null,
        topic: over.topic === undefined ? 'FY27 Ground Robotics — where the autonomy provision landed' : over.topic,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: {
        criteria: null,
        selectedTargetRefs: over.targets ?? [target()],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'personalized_separate', personalization: 'high' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: over.writingGuidanceRefs ?? [],
        campaignFactRefs: over.campaignFactRefs ?? [],
        targetSpecificRefs: over.targetSpecificRefs ?? [],
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

function props(over: Partial<OutreachReviewStepProps> = {}): OutreachReviewStepProps {
  return {
    sessionId: 'session-1',
    session: session(),
    campaignType: 'send_update',
    busy: false,
    applyCommands: vi.fn(async (_commands: OutreachV3Command[]) => undefined),
    toast: vi.fn(),
    onNext: vi.fn(),
    onGenerationStarted: vi.fn(),
    primaryLabel: outreachBuilderPrimaryLabel('review', 'send_update'),
    ...over,
  };
}

function renderStep(over: Partial<OutreachReviewStepProps> = {}) {
  const resolved = props(over);
  return { ...render(<OutreachReviewStep {...resolved} />), props: resolved };
}

describe('OutreachReviewStep', () => {
  beforeEach(() => {
    postCalls.length = 0;
    api.post.mockClear();
    postResponses.approval = { approval: { approvalHash: 'approval-hash-1' } };
    postResponses.generation = { jobId: 'job-1', deduped: false, complete: false, remaining: 2 };
  });

  it('carries the prototype step copy verbatim', () => {
    expect(OUTREACH_BUILDER_STEP_TITLES.review).toBe(
      'Review the packet before anything is written',
    );
    expect(OUTREACH_BUILDER_STEP_SUBLINES.review).toBe(
      'Nothing is generated until you accept this packet. Add a personal note for anyone who needs one.',
    );

    renderStep();
    expect(
      screen.getByRole('button', { name: /Accept packet and generate drafts/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Accepting the packet is what authorises generation. Nothing is written before this.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('A note reaches that person’s draft and no one else’s'),
    ).toBeInTheDocument();
    expect(screen.getByText('Subject line')).toBeInTheDocument();
    expect(screen.getByText('Recipients · personal note')).toBeInTheDocument();
  });

  it('shows the real subject line and recipient count, not a seeded one', () => {
    renderStep({
      session: session({
        topic: 'Autonomy provision update',
        targets: [target(), target({ targetKey: 'directory_staff:staff-1', displayName: 'Priya Anand' })],
      }),
    });
    expect(screen.getByText('Autonomy provision update')).toBeInTheDocument();
    expect(screen.getByText('2 recipients · one email each')).toBeInTheDocument();
  });

  it('says one email in the singular for a single recipient', () => {
    renderStep();
    expect(screen.getByText('1 recipient · one email')).toBeInTheDocument();
  });

  it('reads an unnamed campaign as Not set rather than inventing a subject', () => {
    renderStep({ session: session({ topic: null }) });
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('counts the context actually on the spec', () => {
    renderStep({
      session: session({
        campaignFactRefs: [contextRef(), contextRef({ contextKey: 'ctx-2' })],
        writingGuidanceRefs: [contextRef({ contextKey: 'ctx-3', contextClass: 'writing_guidance' })],
      }),
    });
    expect(screen.getByText('Campaign facts')).toBeInTheDocument();
    expect(screen.getByText('2 records')).toBeInTheDocument();
    expect(screen.getByText('Writing guidance')).toBeInTheDocument();
    expect(screen.getByText('1 record')).toBeInTheDocument();
    expect(
      screen.queryByText('No context selected. Drafts will use the campaign brief only.'),
    ).not.toBeInTheDocument();
  });

  it('states the empty context case instead of showing a chip with no source', () => {
    renderStep();
    expect(
      screen.getByText('No context selected. Drafts will use the campaign brief only.'),
    ).toBeInTheDocument();
  });

  it('flags only the recipients with no usable address', () => {
    renderStep({
      session: session({
        targets: [
          target(),
          target({
            targetKey: 'directory_staff:staff-5',
            displayName: 'Devon Marsh',
            title: 'Legislative Assistant',
            organization: '1032 Longworth',
            email: null,
            emailStatus: 'missing',
          }),
        ],
      }),
    });
    expect(screen.getByText('Rep. Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('Ranking Member · 2245 Rayburn')).toBeInTheDocument();
    expect(screen.getByText('Devon Marsh')).toBeInTheDocument();
    expect(screen.getAllByText('No email on file')).toHaveLength(1);
  });

  it('shows the note already saved on the spec for that recipient', () => {
    renderStep({
      session: session({
        targetSpecificRefs: [
          noteRef('directory_member:member-1', 'Rep. Jane Smith', 'Mention the May briefing.'),
        ],
      }),
    });
    expect(screen.getByLabelText('Personal note for Rep. Jane Smith')).toHaveValue(
      'Mention the May briefing.',
    );
  });

  it('writes a typed note as a target-scoped context ref, then approves and generates', async () => {
    const applyCommands = vi.fn(async (_commands: OutreachV3Command[]) => undefined);
    const toast = vi.fn();
    const onGenerationStarted = vi.fn();
    renderStep({ applyCommands, toast, onGenerationStarted });

    fireEvent.change(screen.getByLabelText('Personal note for Rep. Jane Smith'), {
      target: { value: 'Mention the May briefing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Accept packet and generate drafts/ }));

    await waitFor(() => expect(onGenerationStarted).toHaveBeenCalledTimes(1));

    const commands = (applyCommands.mock.calls.at(0)?.[0] ?? []) as unknown as Array<{
      type: string;
      payload: { selections?: Array<{ scope: { kind: string; targetKey?: string } }> };
    }>;
    const accept = commands.find((command) => command.type === 'ACCEPT_CONTEXT_REFS');
    expect(accept?.payload.selections?.at(0)?.scope).toEqual({
      kind: 'target',
      targetKey: 'directory_member:member-1',
    });

    // The approval must precede generation, and the request key must be the
    // deterministic sessionId:approvalHash — never a random id.
    expect(postCalls.at(0)?.url).toContain('/generation/review-packet-approval');
    expect(postCalls.at(0)?.body).toEqual({});
    expect(postCalls.at(1)?.url).toContain('/generation/full');
    expect(postCalls.at(1)?.body).toEqual({ requestKey: 'session-1:approval-hash-1' });

    expect(toast).toHaveBeenCalledWith('Packet accepted · generating 1 draft');
  });

  it('pluralises the accept toast', async () => {
    const toast = vi.fn();
    const onGenerationStarted = vi.fn();
    renderStep({
      toast,
      onGenerationStarted,
      session: session({
        targets: [
          target(),
          target({ targetKey: 'directory_staff:staff-1', displayName: 'Priya Anand' }),
          target({ targetKey: 'directory_staff:staff-4', displayName: 'Hannah Beck' }),
        ],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /Accept packet and generate drafts/ }));
    await waitFor(() => expect(onGenerationStarted).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Packet accepted · generating 3 drafts');
  });

  it('does not rewrite context when no note changed, so a retry keeps the same request key', async () => {
    const applyCommands = vi.fn(async (_commands: OutreachV3Command[]) => undefined);
    const onGenerationStarted = vi.fn();
    renderStep({
      applyCommands,
      onGenerationStarted,
      session: session({
        targetSpecificRefs: [
          noteRef('directory_member:member-1', 'Rep. Jane Smith', 'Mention the May briefing.'),
        ],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: /Accept packet and generate drafts/ }));
    await waitFor(() => expect(onGenerationStarted).toHaveBeenCalled());
    expect(applyCommands).not.toHaveBeenCalled();
  });

  it('supersedes the previous note refs when a note is edited', async () => {
    const applyCommands = vi.fn(async (_commands: OutreachV3Command[]) => undefined);
    const onGenerationStarted = vi.fn();
    renderStep({
      applyCommands,
      onGenerationStarted,
      session: session({
        targetSpecificRefs: [
          noteRef('directory_member:member-1', 'Rep. Jane Smith', 'Mention the May briefing.'),
        ],
      }),
    });
    fireEvent.change(screen.getByLabelText('Personal note for Rep. Jane Smith'), {
      target: { value: 'Mention the June markup instead.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Accept packet and generate drafts/ }));
    await waitFor(() => expect(onGenerationStarted).toHaveBeenCalled());

    const commands = (applyCommands.mock.calls.at(0)?.[0] ?? []) as unknown as Array<{
      type: string;
      payload: { refs?: Array<{ contextKey: string; reason: string }> };
    }>;
    const exclude = commands.find((command) => command.type === 'EXCLUDE_CONTEXT_REFS');
    expect(exclude?.payload.refs).toEqual([
      { contextKey: 'ctx-note-directory_member:member-1', reason: 'superseded' },
    ]);
  });

  it('fails closed when the approval carries no approval hash', async () => {
    postResponses.approval = { approval: null };
    const onGenerationStarted = vi.fn();
    renderStep({ onGenerationStarted });
    fireEvent.click(screen.getByRole('button', { name: /Accept packet and generate drafts/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toContain('No approval reference was returned');
    expect(onGenerationStarted).not.toHaveBeenCalled();
    expect(postCalls.some((call) => call.url.includes('/generation/full'))).toBe(false);
  });

  it('never treats an ambiguous complete=false / jobId=null response as a started generation', async () => {
    postResponses.generation = { jobId: null, deduped: false, complete: false, remaining: 0 };
    const onGenerationStarted = vi.fn();
    const toast = vi.fn();
    renderStep({ onGenerationStarted, toast });
    fireEvent.click(screen.getByRole('button', { name: /Accept packet and generate drafts/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toContain('Generation did not start');
    expect(onGenerationStarted).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('refuses the press with no recipients instead of generating nothing', () => {
    renderStep({ session: session({ targets: [] }) });
    expect(screen.getByRole('button', { name: /Accept packet and generate drafts/ })).toBeDisabled();
    expect(screen.getByText('0 recipients · one email each')).toBeInTheDocument();
    expect(screen.getByText(/No recipients selected\./)).toBeInTheDocument();
  });

  it('disables the accept button while another command batch is in flight', () => {
    renderStep({ busy: true });
    expect(screen.getByRole('button', { name: /Accept packet and generate drafts/ })).toBeDisabled();
  });
});
