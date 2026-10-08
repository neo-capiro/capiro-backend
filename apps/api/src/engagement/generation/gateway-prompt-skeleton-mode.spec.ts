import { describe, expect, it } from '@jest/globals';
import {
  buildGatewayPrompt,
  buildGatewaySystemPrompt,
  SKELETON_OUTPUT_CONTRACT,
  type GatewayPromptInput,
} from './gateway-prompt.js';
import { SKELETON_SECTIONS_EXEMPLAR, type ContentSkeleton } from './content-skeleton.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';
import type { MessagePlan } from './message-plan.schema.js';

function plan(): MessagePlan {
  return {
    intent: 'request_meeting',
    clientRepresented: 'Career Start',
    desiredOutcome: 'Secure a short meeting.',
    whyRecipient: ['Leads on the submarine industrial base.'],
    whyNow: ['Markup is next week.'],
    clientAsk: ['A 15-minute meeting.'],
    supportedClaims: [],
    unsupportedOrRiskyClaims: [],
    tone: 'professional',
    callToAction: 'Reply with availability.',
    missingCriticalContext: [],
  };
}

function packet(): EvidencePacketV2 {
  return {
    packetId: 'pkt-1',
    surface: 'outreach_email',
    evidence: [],
    directives: [],
    standingMemory: [],
    failures: [],
    coverage: { complete: true, stopReason: null },
  } as unknown as EvidencePacketV2;
}

function skeleton(): ContentSkeleton {
  return {
    subject: 'Meeting request: {{topic}}',
    body: ['Dear {{salutation}},', '', 'Why this matters', '{{why_it_matters}}'].join('\n'),
    slots: [
      { key: 'topic', label: 'Topic', instruction: 'The campaign topic.', required: true },
      { key: 'salutation', label: 'Salutation', instruction: 'Recipient name.', required: true },
      {
        key: 'why_it_matters',
        label: 'Why this matters',
        instruction: 'One supported connection.',
        required: false,
      },
    ],
  };
}

function input(overrides: Partial<GatewayPromptInput> = {}): GatewayPromptInput {
  return {
    packet: packet(),
    plan: plan(),
    styleProfile: null,
    styleProfileBlock: null,
    recipientBrief: 'Name: Ms. Reyes',
    clientBrief: null,
    audienceKind: 'individual',
    tone: 'professional',
    length: 'short',
    senderName: null,
    recipientScopeKeys: [],
    now: new Date('2026-08-25T00:00:00Z'),
    ...overrides,
  } as GatewayPromptInput;
}

describe('gateway prompt — free-body mode is unchanged', () => {
  /**
   * Skeleton mode is purely additive. Every existing caller (all of Classic
   * outreach, and any V3 campaign without a template) must produce a prompt
   * that still asks for a whole email.
   */
  it('still asks for subject/body when no skeleton is supplied', () => {
    const prompt = buildGatewayPrompt(input());
    expect(prompt.system).toContain('"subject" (string), "body" (string)');
    expect(prompt.system).not.toContain('"sections" (array)');
  });

  it('keeps the whole-email length target and the signature rule', () => {
    const prompt = buildGatewayPrompt(input());
    expect(prompt.userStatic).toContain('Target length: a short message');
    expect(prompt.userStatic).toContain('Do NOT add a signature block');
  });

  it('emits no TEMPLATE SECTIONS block', () => {
    expect(buildGatewayPrompt(input()).userStatic).not.toContain('TEMPLATE SECTIONS');
  });

  it('emits no worked example — it would be noise with nothing to map onto', () => {
    const prompt = buildGatewayPrompt(input());
    expect(prompt.userStatic).not.toContain('WORKED EXAMPLE');
    expect(prompt.userVolatile).not.toContain('WORKED EXAMPLE');
  });
});

describe('gateway prompt — skeleton mode', () => {
  it('swaps the output contract for the sections shape', () => {
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.system).toContain('"sections" (array)');
    // The old contract must be GONE, not merely supplemented: a model told to
    // return a "body" writes a whole email and duplicates every heading.
    expect(prompt.system).not.toContain('"subject" (string), "body" (string)');
  });

  it('drops the whole-email length target, which the template now controls', () => {
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic).not.toContain('Target length: a short message');
    expect(prompt.userStatic).toContain('the template controls overall length');
  });

  it('replaces the signature rule with a no-sign-off-in-sections rule', () => {
    // The original rule tells the model how to END AN EMAIL. In skeleton mode
    // that made each section try to sign off.
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic).not.toContain('Do NOT add a signature block');
    expect(prompt.userStatic).toContain('Do NOT write any greeting, closing, signature');
  });

  it('puts the skeleton in the CACHEABLE static prefix, not the per-recipient tail', () => {
    // It is identical for every recipient in the campaign, so paying for it
    // once per batch instead of once per recipient is the point of the split.
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic).toContain('TEMPLATE SECTIONS');
    expect(prompt.userVolatile).not.toContain('TEMPLATE SECTIONS');
  });

  it('briefs every slot with its key, optionality and instruction', () => {
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic).toContain('key="topic"');
    expect(prompt.userStatic).toContain('The campaign topic.');
    expect(prompt.userStatic).toMatch(/key="why_it_matters".*OPTIONAL/);
    expect(prompt.userStatic).toMatch(/key="salutation".*REQUIRED/);
  });

  it('keeps the message plan authoritative — a skeleton cannot smuggle in claims', () => {
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.system).toContain('MESSAGE PLAN RULE');
    expect(prompt.userStatic).toContain('VALIDATED MESSAGE PLAN');
    expect(prompt.userVolatile).toContain('Call to action: Reply with availability.');
  });

  it('includes the worked example, inside the spotlight markers', () => {
    // Inside the markers because it contains a sample template AND a sample JSON
    // response — without them, that is a plausible thing to answer directly
    // rather than learn a shape from.
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic).toContain('WORKED EXAMPLE');
    expect(prompt.userStatic).toContain('source="worked_example"');
    expect(prompt.userStatic).toContain(SKELETON_SECTIONS_EXEMPLAR);
  });

  it('puts the worked example in the CACHEABLE prefix, not the per-recipient tail', () => {
    // Identical for every recipient, so paying for it once per batch rather than
    // once per recipient is the whole point of the static/volatile split.
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userVolatile).not.toContain('WORKED EXAMPLE');
  });

  it('shows the example BEFORE the real sections, so shape is read before task', () => {
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic.indexOf('WORKED EXAMPLE')).toBeLessThan(
      prompt.userStatic.indexOf('TEMPLATE SECTIONS'),
    );
  });

  it('never lets the example be confused for the campaign’s own template', () => {
    // Both a real skeleton and an example skeleton are in the prompt. The real
    // one must be the one marked as the task.
    const prompt = buildGatewayPrompt(input({ contentSkeleton: skeleton() }));
    expect(prompt.userStatic).toContain('TEMPLATE SECTIONS — THIS IS THE TASK');
    expect(prompt.userStatic).toContain('Ignore its topic entirely');
    // The example's throwaway slot names must not appear in the real task's
    // section list, which is built only from the campaign's own skeleton.
    const taskPart = prompt.userStatic.slice(prompt.userStatic.indexOf('TEMPLATE SECTIONS'));
    expect(taskPart).not.toContain('key="opening"');
  });

  it('REVISION mode ignores a skeleton rather than re-deriving an edited body', () => {
    // The user is refining prose that already exists; regenerating it from
    // sections would silently discard their edits.
    const prompt = buildGatewayPrompt(
      input({
        contentSkeleton: skeleton(),
        existingBody: 'An existing draft the user has been editing.',
        existingSubject: 'Existing subject',
      }),
    );
    expect(prompt.mode).toBe('revision');
    expect(prompt.userStatic).not.toContain('TEMPLATE SECTIONS');
    expect(prompt.userStatic).not.toContain('WORKED EXAMPLE');
    expect(prompt.system).toContain('REVISION OUTPUT CONTRACT');
    expect(prompt.system).not.toContain('"subject" (string), "body" (string)');
  });

  it('works for a GROUP audience without leaking per-recipient framing', () => {
    const prompt = buildGatewayPrompt(
      input({ contentSkeleton: skeleton(), audienceKind: 'group', groupMemberCount: 4 }),
    );
    expect(prompt.mode).toBe('group');
    expect(prompt.userStatic).toContain('TEMPLATE SECTIONS');
    expect(prompt.userStatic).toContain('GROUP of 4');
  });
});

describe('buildGatewaySystemPrompt', () => {
  it('puts the latest edit after earlier recipient preferences and omits restyling directions', () => {
    const earlier = 'Use government affairs and em dashes.';
    const latest = 'Remove dashes and replace government affairs with Lobbying Firm.';
    const prompt = buildGatewayPrompt(input({
      existingSubject: 'Original subject',
      existingBody: 'Hi Hannah, I work with a government affairs firm — thanks.',
      reviseInstruction: latest,
      packet: { ...packet(), directives: [{ id: 'old-note', kind: 'custom_note', text: earlier, scope: 'hannah', authenticatedUserId: 'u1' }] },
      recipientScopeKeys: ['hannah'],
      styleProfileBlock: 'Use lots of em dashes.',
      styleSamples: [{ sampleKey: 'sample-1', label: null, subject: 'Sample', body: 'Entirely different sample email.' }],
    }));
    expect(prompt.userVolatile.indexOf(latest)).toBeGreaterThan(prompt.userVolatile.indexOf(earlier));
    expect(prompt.userStatic).not.toContain('Target length');
    expect(prompt.userStatic).not.toContain('Do NOT add a signature');
    expect(prompt.userStatic).not.toContain('Use lots of em dashes.');
    expect(prompt.userStatic).not.toContain('Entirely different sample email.');
    expect(prompt.userVolatile).toContain('source="existing_draft"');
    expect(prompt.system).toContain('The latest explicit editing instruction overrides');
  });

  it('is byte-identical to before when no mode is passed', () => {
    expect(buildGatewaySystemPrompt()).toBe(buildGatewaySystemPrompt({ skeleton: false }));
  });

  it('includes the skeleton contract only in skeleton mode', () => {
    expect(buildGatewaySystemPrompt({ skeleton: true })).toContain(SKELETON_OUTPUT_CONTRACT);
    expect(buildGatewaySystemPrompt({ skeleton: false })).not.toContain(SKELETON_OUTPUT_CONTRACT);
  });

  it('repeats the do-not-write-structure rule in the system prompt', () => {
    // Deliberate duplication with the user block: this is the one rule whose
    // violation silently duplicates every heading in the assembled email.
    expect(SKELETON_OUTPUT_CONTRACT).toContain('SECTION CONTENT ONLY');
    expect(SKELETON_OUTPUT_CONTRACT).toMatch(/would appear twice/);
  });

  it('forbids headings inside section prose, since the template owns them', () => {
    expect(SKELETON_OUTPUT_CONTRACT).toMatch(/Do not use headings/);
  });
});
