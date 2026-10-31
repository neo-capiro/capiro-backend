import { describe, expect, test, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import { debriefContextTokens, type MeetingDebriefContextInput } from './meeting-debrief-context.js';
import { MEETING_DEBRIEF_POLICY } from './meeting-prep-policy.js';
import { createGovernedMeetingAiService } from './governed-meeting-ai.factory.js';
import {
  runWithMeetingGovernedContext,
  type MeetingGovernedContext,
} from './meeting-context-runtime.js';
import type { EngagementAiService } from './engagement-ai.service.js';

function governedBundle(modelContextBlock = 'GOVERNED-CONTEXT'): MeetingGovernedContext {
  return {
    kind: 'governed_packet',
    mode: 'debrief',
    meetingId: 'meeting-1',
    clientId: 'client-1',
    packetId: 'packet-1',
    traceHash: 'trace-1',
    modelContextBlock,
    coverage: {
      complete: true,
      requestedDomains: [],
      searchedDomains: [],
      missingDomains: [],
      partialDomains: [],
      recordsReturned: 0,
      paginationComplete: true,
      truncated: false,
      stopReason: 'complete',
    },
  };
}

const ctx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  tenantSlug: 'acme',
  userId: '22222222-2222-2222-2222-222222222222',
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

const transcript = 'The client asked about the markup schedule and the staff director agreed to follow up. '.repeat(
  20,
);

function harness() {
  const meeting = {
    id: 'meeting-1',
    subject: 'Markup schedule',
    startsAt: new Date('2026-10-12T13:00:00.000Z'),
    endsAt: new Date('2026-10-12T14:00:00.000Z'),
    location: 'Zoom',
    status: 'scheduled',
    description: 'Weekly check-in',
    clientId: 'client-1',
    client: { id: 'client-1', name: 'Synthetic Strategies', sectorTag: 'defense' },
    attendees: [{ name: 'Ada Example', email: 'ada@example.test', role: 'client' }],
    preps: [{ id: 'prep-1', status: 'approved', summary: 'Recess timing', agenda: [], talkingPoints: [], risks: [], followUps: [] }],
    tasks: [{ title: 'Send the one-pager', status: 'open', dueDate: new Date('2026-10-20T00:00:00.000Z') }],
  };
  const tx = {
    meeting: { findFirst: jest.fn(async () => meeting) },
    client: { findUnique: jest.fn(async () => meeting.client) },
    meetingDebrief: {
      // Loosely typed: the canonical body policy needs confidential/accessLevel/authorUserId,
      // which individual cases supply.
      findMany: jest.fn(async (): Promise<unknown[]> => [
        {
          createdAt: new Date('2026-10-05T15:00:00.000Z'),
          bodyCiphertext: 'prior-recap',
          iv: 'iv',
          authTag: 'tag',
        },
      ]),
    },
  };
  const generated = {
    recap: 'Recap.',
    actionItems: ['Send the one-pager'],
    notes: 'Notes.',
    provider: 'anthropic' as const,
    model: 'synthetic-model',
    usage: { inputTokens: 1234, outputTokens: 321 },
    usedTenantKey: false,
    // The provider envelope that must never reach the caller.
    raw: { content: [{ type: 'thinking', thinking: 'SECRET-THINKING-BLOCK' }] },
  };
  const generateMeetingDebrief = jest.fn<
    (input: MeetingDebriefContextInput, tenant?: TenantContext | null) => Promise<unknown>
  >(async () => generated);
  const ai = { generateMeetingDebrief };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service as unknown as Record<string, unknown>, {
    prisma: { withTenant: (_t: string, fn: (tx: unknown) => unknown) => fn(tx) },
    ai,
    notesCrypto: {
      decrypt: ({ bodyCiphertext }: { bodyCiphertext: string }) =>
        bodyCiphertext === 'prior-recap' ? 'Prior debrief: agreed to share the funding table.' : null,
    },
    listMeetingNotes: jest.fn(async () => [{ body: 'Client flagged recess timing.', restricted: false, createdAt: new Date('2026-10-12T14:05:00Z') }]),
    loadUserVoiceBlock: jest.fn(async () => 'Firm voice: precise.'),
    recordAiUsage: jest.fn(async () => undefined),
    resolveEffectiveMeetingClientId: jest.fn(async () => 'client-1'),
  });
  // filterResearchPortfolioMeetingPreps is a module function with a tx dependency; the
  // scoped call above is short-circuited by returning the prep unchanged.
  return { service, ai, generateMeetingDebrief, generated, tx };
}

describe('D2 debrief draft payload and context', () => {
  test('passes only D2 fields, bounded, and returns no provider raw', async () => {
    const h = harness();
    const result = await h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
      method: 'upload',
      sourceText: transcript,
    });

    const calls = h.generateMeetingDebrief.mock.calls;
    expect(calls).toHaveLength(1);
    const input = calls[0]![0];
    expect(Object.keys(input).sort()).toEqual(
      ['attendees', 'client', 'meeting', 'openTasks', 'prep', 'recentDebriefs', 'source', 'steeringContext', 'visibleNotes'].sort(),
    );
    expect(debriefContextTokens(input)).toBeLessThanOrEqual(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(input.source.text).toBe(transcript.trim());
    expect(input.recentDebriefs[0]?.recap).toContain('Prior debrief');
    expect(input.openTasks[0]).toMatchObject({ title: 'Send the one-pager', dueOn: '2026-10-20' });

    // No raw envelope, no thinking block, no prompt echo in the returned payload.
    expect(result).not.toHaveProperty('raw');
    expect(JSON.stringify(result)).not.toContain('SECRET-THINKING-BLOCK');
    expect(result).toMatchObject({
      provider: 'anthropic',
      model: 'synthetic-model',
      usage: { inputTokens: 1234, outputTokens: 321 },
    });

    // The auditable record of what the model saw rides with the draft.
    expect(result.contextSummary.boundTokens).toBe(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(result.contextSummary.totalTokens).toBe(debriefContextTokens(input));
    expect(result.contextSummary.sections.map((section) => section.name)).toContain('source');
  });

  test('an oversized transcript is still bounded and the truncation is recorded', async () => {
    const h = harness();
    const huge = transcript.repeat(40);
    const result = await h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
      method: 'upload',
      sourceText: huge,
    });
    const calls = h.generateMeetingDebrief.mock.calls;
    expect(calls).toHaveLength(1);
    const input = calls[0]![0];
    expect(debriefContextTokens(input)).toBeLessThanOrEqual(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(result.contextSummary.totalTokens).toBe(debriefContextTokens(input));
    expect(result.contextSummary.sourceTruncated).toBe(true);
    expect(input.source.text.length).toBeLessThan(huge.length);
  });

  test('an empty source is refused without calling the model', async () => {
    const h = harness();
    await expect(
      h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', { method: 'manual', sourceText: ' ' }),
    ).rejects.toThrow(/sourceText/);
    expect(h.ai.generateMeetingDebrief).not.toHaveBeenCalled();
  });
});

describe('D2 continuity policy and governed composition', () => {
  test('prior-debrief continuity admits a readable row and omits a restricted one', async () => {
    const h = harness();
    h.tx.meetingDebrief.findMany.mockResolvedValueOnce([
      {
        createdAt: new Date('2026-10-05T15:00:00.000Z'),
        bodyCiphertext: 'prior-recap',
        iv: 'iv',
        authTag: 'tag',
        confidential: false,
        accessLevel: 'author_only',
        authorUserId: 'another-user',
      },
      {
        createdAt: new Date('2026-10-06T15:00:00.000Z'),
        bodyCiphertext: 'RESTRICTED-SYNTHETIC-DEBRIEF',
        iv: 'iv',
        authTag: 'tag',
        // Same tenant, same client, another author, author-only: the canonical body
        // predicate says this reader may not see it.
        confidential: true,
        accessLevel: 'author_only',
        authorUserId: 'another-user',
      },
    ]);
    Object.assign((h.service as unknown as { notesCrypto: Record<string, unknown> }).notesCrypto, {
      decrypt: ({ bodyCiphertext }: { bodyCiphertext: string }) =>
        bodyCiphertext === 'prior-recap' ? 'Prior debrief recap.' : bodyCiphertext,
    });

    await h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
      method: 'upload',
      sourceText: transcript,
    });

    const input = h.generateMeetingDebrief.mock.calls[0]![0];
    expect(input.recentDebriefs).toHaveLength(1);
    expect(input.recentDebriefs[0]?.recap).toBe('Prior debrief recap.');
    expect(JSON.stringify(input)).not.toContain('RESTRICTED-SYNTHETIC-DEBRIEF');
  });

  test('a 20 000-byte transcript completes through the real governed wrapper with identity intact', async () => {
    const h = harness();
    (h.service as unknown as { ai: unknown }).ai = createGovernedMeetingAiService(
      h.ai as unknown as EngagementAiService,
    );
    const longTranscript = transcript.repeat(12);
    expect(Buffer.byteLength(longTranscript, 'utf8')).toBeGreaterThan(19_000);

    const result = await runWithMeetingGovernedContext(governedBundle(), () =>
      h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
        method: 'upload',
        sourceText: longTranscript,
      }),
    );

    expect(h.generateMeetingDebrief).toHaveBeenCalledTimes(1);
    const input = h.generateMeetingDebrief.mock.calls[0]![0];
    // The mandatory scope identity the governed guard re-asserts survives bounding.
    expect(input.meeting.id).toBe('meeting-1');
    expect(input.client?.id).toBe('client-1');
    expect(result.contextSummary.sourceTruncated).toBe(true);
    expect(result.contextSummary.totalTokens).toBe(
      debriefContextTokens(input as MeetingDebriefContextInput),
    );
    expect(result.contextSummary.totalTokens).toBeLessThanOrEqual(
      MEETING_DEBRIEF_POLICY.contextTokens,
    );
  });

  test('overflow keeps the canonical governed steering and bounds the rest', async () => {
    const h = harness();
    (h.service as unknown as { ai: unknown }).ai = createGovernedMeetingAiService(
      h.ai as unknown as EngagementAiService,
    );
    const block = `GOVERNED-CONTEXT ${'g'.repeat(2_000)}`;
    // ~6 900-byte source + 2 000-byte governed block: over budget, so something must go —
    // and it must NOT be the canonical governed projection.
    const source = transcript.repeat(4);
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(6_000);

    const result = await runWithMeetingGovernedContext(governedBundle(block), () =>
      h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
        method: 'upload',
        sourceText: source,
      }),
    );

    const input = h.generateMeetingDebrief.mock.calls[0]![0] as MeetingDebriefContextInput;
    const measured = debriefContextTokens(input);
    // The required governed content survives, verbatim.
    expect(input.steeringContext).toBe(block);
    expect(
      result.contextSummary.sections.find((section) => section.name === 'steeringContext')?.state,
    ).toBe('kept');
    // The total is still bounded and the summary is exactly what was sent.
    expect(measured).toBeLessThanOrEqual(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(result.contextSummary.totalTokens).toBe(measured);
    // The reviewed evidence is what gave way.
    expect(result.contextSummary.sourceTruncated).toBe(true);
    // Identity survives the overflow.
    expect(input.meeting.id).toBe('meeting-1');
    expect(input.client?.id).toBe('client-1');
  });

  test('an oversized optional description is reduced before the reviewed source', async () => {
    const h = harness();
    (h.service as unknown as { ai: unknown }).ai = createGovernedMeetingAiService(
      h.ai as unknown as EngagementAiService,
    );
    // A valid stored source shape: IsString with no length limit.
    const description = 'D'.repeat(20_000);
    h.tx.meeting.findFirst.mockResolvedValueOnce({
      ...(await h.tx.meeting.findFirst()),
      description,
    });
    const shortSource = ['Three lines.', 'Second line.', 'Third line.'].join(String.fromCharCode(10));


    const result = await runWithMeetingGovernedContext(governedBundle(), () =>
      h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
        method: 'upload',
        sourceText: shortSource,
      }),
    );

    const input = h.generateMeetingDebrief.mock.calls[0]![0] as MeetingDebriefContextInput;
    const measured = debriefContextTokens(input);
    expect(measured).toBeLessThanOrEqual(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(result.contextSummary.totalTokens).toBe(measured);
    // The reviewed evidence survives untouched; the optional description does not.
    expect(result.contextSummary.sourceTruncated).toBe(false);
    expect(input.source.text).toBe(shortSource);
    expect(input.meeting).not.toHaveProperty('description');
    expect(input.meeting.id).toBe('meeting-1');
    expect(input.client?.id).toBe('client-1');
  });

  test('a governed block that fits is sent verbatim and counted in the bound', async () => {
    const h = harness();
    (h.service as unknown as { ai: unknown }).ai = createGovernedMeetingAiService(
      h.ai as unknown as EngagementAiService,
    );
    const block = `GOVERNED-CONTEXT ${'g'.repeat(2_000)}`;

    const result = await runWithMeetingGovernedContext(governedBundle(block), () =>
      h.service.generateMeetingDebriefDraft(ctx, 'meeting-1', {
        method: 'upload',
        sourceText: transcript,
      }),
    );

    const input = h.generateMeetingDebrief.mock.calls[0]![0] as MeetingDebriefContextInput;
    expect(input.steeringContext).toBe(block);
    const measured = debriefContextTokens(input);
    expect(measured).toBeLessThanOrEqual(MEETING_DEBRIEF_POLICY.contextTokens);
    expect(result.contextSummary.totalTokens).toBe(measured);
    expect(
      result.contextSummary.sections.find((section) => section.name === 'steeringContext')?.tokens,
    ).toBeGreaterThan(2_000);
  });
});
