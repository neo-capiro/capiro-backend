/**
 * Message Plan validation (Phase 1 §3.f3, §5.3).
 *
 * The validators run BEFORE drafting, so each of these is a case where no
 * recipient-facing token should ever be spent.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import {
  MessagePlanService,
  type BuildPlanRequest,
} from './message-plan.service.js';
import { MessagePlanInvalidError, messagePlanSchema, type MessagePlan } from './message-plan.schema.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CTX = {
  tenantId: 't1',
  tenantSlug: 'tenant',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'user',
} as unknown as TenantContext;

function service() { return new MessagePlanService(); }

function packet(over: Partial<EvidencePacketV2> = {}): EvidencePacketV2 {
  return {
    packetId: 'p',
    packetVersion: 2,
    tenantId: 't1',
    userId: 'u1',
    clientId: 'c1',
    surface: 'outreach_email',
    ref: {},
    directives: [],
    evidence: [
      {
        ref: {
          sourceType: 'bill',
          sourceId: 'hr1234-119',
          title: 'HR 1234',
          trust: 'authoritative_structured',
          retrievedAt: NOW.toISOString(),
          authoritativeAsOf: '2026-07-20T00:00:00.000Z',
        },
        evidenceText: 'HR 1234 referred to Armed Services.',
        scope: 'all',
      },
    ],
    standingMemory: [],
    standingMemoryExclusions: [],
    failures: [],
    modelPolicy: { provider: 'anthropic', model: 'm', promptSpecVersion: 'v2.2-gateway' },
    criticalFailureCount: 0,
    freshestSourceAt: null,
    stalestSourceAt: null,
    compiledAt: NOW.toISOString(),
    packetHash: 'h',
    emailScope: 'mine',
    ...over,
  };
}

function plan(over: Partial<MessagePlan> = {}): MessagePlan {
  return {
    intent: 'meeting_request',
    clientRepresented: 'Aperture Defense Systems',
    desiredOutcome: 'A 20-minute meeting before the FY27 markup.',
    whyRecipient: ['Sits on Armed Services.'],
    whyNow: ['The markup is approaching.'],
    clientAsk: ['A 20-minute meeting.'],
    supportedClaims: [
      {
        claim: 'HR 1234 was referred to Armed Services.',
        sourceIds: ['hr1234-119'],
        asOf: '2026-07-20',
        claimType: 'legislative_status',
      },
    ],
    unsupportedOrRiskyClaims: [],
    tone: 'professional',
    callToAction: 'Could we find 20 minutes?',
    missingCriticalContext: [],
    ...over,
  };
}

function validate(p: MessagePlan, over: { packet?: EvidencePacketV2; audienceKind?: 'individual' | 'group' } = {}) {
  return service().validatePlan(p, {
    packet: over.packet ?? packet(),
    recipientBrief: 'Name: Dana Reed',
    audienceKind: over.audienceKind ?? 'individual',
    clientName: 'Aperture Defense Systems',
    tone: 'professional',
    recipientScopeKeys: [],
  });
}

function issueCodes(fn: () => void): string[] {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof MessagePlanInvalidError) return e.issues.map((i) => i.code);
    throw e;
  }
}

describe('a valid plan passes', () => {
  test('no issues for a well-formed plan', () => {
    expect(() => validate(plan())).not.toThrow();
  });
});

describe('recipient-specific context reaches the planner after evidence', () => {
  test('the plan prompt includes selected evidence and places the mandatory scoped note after it', () => {
    const selectedText = 'The client expects the procurement review in October.';
    const noteText = 'Mention the review only when it helps the ask.';
    const request: BuildPlanRequest = {
      packet: packet({
        evidence: [{
          ref: {
            sourceType: 'document', sourceId: 'doc-brief', title: 'Client brief',
            trust: 'external_untrusted', retrievedAt: NOW.toISOString(),
          },
          evidenceText: selectedText,
          scope: 'dana',
        }],
        directives: [{
          id: 'note:dana', kind: 'custom_note', text: noteText,
          scope: 'dana', authenticatedUserId: 'u1',
        }],
      }),
        recipientBrief: 'Name: Dana Reed',
      audienceKind: 'individual',
      clientName: 'Aperture Defense Systems',
      tone: 'professional',
      recipientScopeKeys: ['dana'],
    };
    const renderer = service() as unknown as {
      renderPlanPrompt(input: BuildPlanRequest): { system: string; userVolatile: string };
    };

    const prompt = renderer.renderPlanPrompt(request);
    expect(prompt.userVolatile).toContain(selectedText);
    expect(prompt.userVolatile).toContain(noteText);
    expect(prompt.userVolatile.indexOf(noteText)).toBeGreaterThan(prompt.userVolatile.indexOf(selectedText));
    expect(prompt.system).toContain('mandatory for their matching recipient/group');
    expect(prompt.system).toContain('do not silently ignore selected sources');
  });
});

describe('claims must cite evidence that is actually in the packet', () => {
  test('an unknown source id is rejected (§4.22)', () => {
    const codes = issueCodes(() =>
      validate(
        plan({
          supportedClaims: [
            {
              claim: 'S. 999 advanced.',
              sourceIds: ['s999-does-not-exist'],
              asOf: '2026-07-20',
              claimType: 'legislative_status',
            },
          ],
        }),
      ),
    );
    expect(codes).toContain('CLAIM_CITES_UNKNOWN_SOURCE');
  });

  test('a composite id form (type-id / type:id) still resolves', () => {
    expect(() =>
      validate(
        plan({
          supportedClaims: [
            {
              claim: 'HR 1234 was referred.',
              sourceIds: ['bill-hr1234-119'],
              asOf: '2026-07-20',
              claimType: 'legislative_status',
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe('critical packet failures stop drafting', () => {
  test('a critical source failure blocks the plan', () => {
    const codes = issueCodes(() =>
      validate(plan(), {
        packet: packet({
          criticalFailureCount: 1,
          failures: [
            {
              sourceType: 'bill',
              severity: 'critical',
              code: 'BILL_NOT_ON_RECORD',
              userMessage: 'no record',
            },
          ],
        }),
      }),
    );
    expect(codes).toContain('CRITICAL_SOURCE_FAILURE');
  });
});

describe('risky claims cannot leak into the ask', () => {
  test('a claim marked unsupported may not reappear in clientAsk', () => {
    const codes = issueCodes(() =>
      validate(
        plan({
          clientAsk: ['Confirm your support for the directed energy program'],
          unsupportedOrRiskyClaims: [
            {
              claim: 'Confirm your support for the directed energy program',
              reason: 'No evidence of a position.',
              claimType: 'recipient_position',
            },
          ],
        }),
      ),
    );
    expect(codes).toContain('RISKY_CLAIM_IN_ASK');
  });

  test('an unrelated risky claim does not false-positive', () => {
    expect(() =>
      validate(
        plan({
          unsupportedOrRiskyClaims: [
            {
              claim: 'The agency has already selected a vendor',
              reason: 'No evidence.',
              claimType: 'other',
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe('claim requirements', () => {
  test('a legislative claim with no as-of date is rejected', () => {
    const codes = issueCodes(() =>
      validate(
        plan({
          supportedClaims: [
            {
              claim: 'HR 1234 was referred.',
              sourceIds: ['hr1234-119'],
              asOf: null,
              claimType: 'legislative_status',
            },
          ],
        }),
      ),
    );
    expect(codes).toContain('CLAIM_MISSING_AS_OF');
  });
});

describe('group scoping (§4.21)', () => {
  test('a per-member claim supported only by recipient-scoped evidence is rejected', () => {
    const scoped = packet({
      evidence: [
        {
          ref: {
            sourceType: 'directory',
            sourceId: 'dir-dana',
            title: 'Dana',
            trust: 'external_untrusted',
            retrievedAt: NOW.toISOString(),
          },
          evidenceText: 'Dana sits on Armed Services.',
          scope: 'rep-dana',
        },
      ],
    });
    const codes = issueCodes(() =>
      validate(
        plan({
          supportedClaims: [
            {
              claim: 'You sit on Armed Services.',
              sourceIds: ['dir-dana'],
              asOf: null,
              claimType: 'recipient_attribute',
            },
          ],
        }),
        { packet: scoped, audienceKind: 'group' },
      ),
    );
    expect(codes).toContain('GROUP_CLAIM_NOT_COMMON');
  });

  test('the same claim to an INDIVIDUAL is allowed', () => {
    const scoped = packet({
      evidence: [
        {
          ref: {
            sourceType: 'directory',
            sourceId: 'dir-dana',
            title: 'Dana',
            trust: 'external_untrusted',
            retrievedAt: NOW.toISOString(),
          },
          evidenceText: 'Dana sits on Armed Services.',
          scope: 'rep-dana',
        },
      ],
    });
    expect(() =>
      validate(
        plan({
          supportedClaims: [
            {
              claim: 'You sit on Armed Services.',
              sourceIds: ['dir-dana'],
              asOf: null,
              claimType: 'recipient_attribute',
            },
          ],
        }),
        { packet: scoped, audienceKind: 'individual' },
      ),
    ).not.toThrow();
  });
});

describe('revision planning', () => {
  test('plans changes against the current draft and gives the latest instruction precedence', () => {
    const svc = service() as unknown as {
      renderPlanPrompt: (input: unknown) => { system: string; userStatic: string; userVolatile: string };
    };
    const prompt = svc.renderPlanPrompt({
      packet: packet(),
      recipientScopeKeys: [],
      audienceKind: 'individual',
      recipientBrief: 'Name: Hannah',
      tone: 'formal',
      clientName: null,
      existingSubject: 'Original subject',
      existingBody: 'Please meet on October 22 or 23.',
      reviseInstruction: 'Remove dashes and use Lobbying Firm.',
    });
    expect(prompt.system).toContain('REVISION PLANNING');
    expect(prompt.system).toContain('Preserve its purpose and ask');
    expect(prompt.userStatic).not.toContain('Tone: formal');
    expect(prompt.userVolatile).toContain('October 22 or 23');
    expect(prompt.userVolatile).toContain('LATEST EDITING INSTRUCTION');
    expect(prompt.userVolatile).toContain('Remove dashes and use Lobbying Firm.');
  });
});
