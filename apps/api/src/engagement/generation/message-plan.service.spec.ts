/**
 * Message Plan validation (Phase 1 §3.f3, §5.3).
 *
 * The validators run BEFORE drafting, so each of these is a case where no
 * recipient-facing token should ever be spent.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { MessagePlanService, supportsStrictJson } from './message-plan.service.js';
import { MessagePlanInvalidError, type MessagePlan } from './message-plan.schema.js';
import { policyForAudience } from './government-affairs-policy.registry.js';
import type { EvidencePacketV2 } from './evidence-packet.types.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CTX = {
  tenantId: 't1',
  tenantSlug: 'tenant',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'user',
} as unknown as TenantContext;

function service(fastModel = '') {
  const config = { get: () => fastModel } as never;
  const llm = { complete: jest.fn() } as never;
  return new MessagePlanService(config, llm);
}

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
    policy: {
      jurisdiction: 'federal',
      audienceType: 'congressional_office',
      policyId: 'federal.congressional_office',
      version: 'ga-policy-v1',
    },
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
    jurisdiction: 'federal',
    audienceType: 'congressional_office',
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
    policy: policyForAudience('congressional_office'),
    creds: [],
    recipientBrief: 'Name: Dana Reed',
    audienceKind: over.audienceKind ?? 'individual',
    clientName: 'Aperture Defense Systems',
    tone: 'professional',
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

describe('policy conformance', () => {
  test('a plan may not reassign its own audience', () => {
    const codes = issueCodes(() => validate(plan({ audienceType: 'client_executive' })));
    expect(codes).toContain('PLAN_AUDIENCE_MISMATCH');
  });

  test('a plan may not reassign its own jurisdiction', () => {
    const codes = issueCodes(() => validate(plan({ jurisdiction: 'state' })));
    expect(codes).toContain('PLAN_JURISDICTION_MISMATCH');
  });

  test('an intent the audience does not allow is rejected', () => {
    const codes = issueCodes(() => validate(plan({ intent: 'comment_submission' })));
    expect(codes).toContain('PLAN_INTENT_NOT_ALLOWED');
  });

  test('a congressional message is held to ONE ask', () => {
    const codes = issueCodes(() =>
      validate(plan({ clientAsk: ['A meeting.', 'Also cosponsor the bill.'] })),
    );
    expect(codes).toContain('MULTIPLE_ASKS');
  });

  test('a legislative claim with no as-of date is rejected for this audience', () => {
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

describe('plan model selection', () => {
  const cred = {
    provider: 'anthropic' as const,
    apiKey: 'k',
    model: 'claude-sonnet-4-6',
    usedTenantKey: false,
    modelOverridden: false,
  };

  test('a configured fast model that supports strict JSON is used', () => {
    expect(service('claude-haiku-4-5-20251001').resolvePlanModel(cred)).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  test('an UNKNOWN fast model is NOT assumed to support strict JSON', () => {
    // Guessing the other way would produce unparseable plans on a BYOK model.
    expect(service('some-byok-model-v3').resolvePlanModel(cred)).toBe('claude-sonnet-4-6');
  });

  test("a tenant's explicit model override always wins", () => {
    expect(
      service('claude-haiku-4-5-20251001').resolvePlanModel({ ...cred, modelOverridden: true }),
    ).toBe('claude-sonnet-4-6');
  });

  test('with no fast model configured, the draft model plans', () => {
    expect(service('').resolvePlanModel(cred)).toBe('claude-sonnet-4-6');
  });

  test('supportsStrictJson recognizes the known families only', () => {
    expect(supportsStrictJson('gpt-4.1-mini')).toBe(true);
    expect(supportsStrictJson('claude-haiku-4-5-20251001')).toBe(true);
    expect(supportsStrictJson('llama-3-70b')).toBe(false);
    expect(supportsStrictJson('')).toBe(false);
  });
});

describe('no drafting call on an invalid plan', () => {
  test('buildPlan raises MessagePlanInvalidError with no credential', async () => {
    await expect(
      service().buildPlan(CTX, {
        packet: packet(),
        policy: policyForAudience('congressional_office'),
        creds: [],
        recipientBrief: null,
        audienceKind: 'individual',
        clientName: null,
        tone: 'professional',
      }),
    ).rejects.toBeInstanceOf(MessagePlanInvalidError);
  });
});
