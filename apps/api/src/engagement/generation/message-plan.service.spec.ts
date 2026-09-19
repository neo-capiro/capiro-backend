/**
 * Message Plan validation (Phase 1 §3.f3, §5.3).
 *
 * The validators run BEFORE drafting, so each of these is a case where no
 * recipient-facing token should ever be spent.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { MessagePlanService, MESSAGE_PLAN_MAX_OUTPUT_TOKENS, supportsStrictJson } from './message-plan.service.js';
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
    creds: [],
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
        creds: [],
        recipientBrief: null,
        audienceKind: 'individual',
        clientName: null,
        tone: 'professional',
        recipientScopeKeys: [],
      }),
    ).rejects.toBeInstanceOf(MessagePlanInvalidError);
  });
});

describe('plan pass token ceiling', () => {
  // Regression: gpt-5 at max effort counts REASONING tokens against
  // max_output_tokens. A 2000 ceiling starved the planner so it returned
  // `incomplete / max_output_tokens` with empty text → MESSAGE_PLAN_INVALID and
  // no draft (§4.22). buildPlan must request the raised ceiling.
  test('buildPlan requests MESSAGE_PLAN_MAX_OUTPUT_TOKENS, not the starved 2000', async () => {
    const llm = {
      complete: jest.fn(async () => ({
        text: JSON.stringify(plan()),
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const config = { get: () => '' } as never;
    const svc = new MessagePlanService(config, llm as never);
    const cred = {
      provider: 'openai',
      apiKey: String(123),
      model: 'gpt-5',
      modelOverridden: false,
    } as never;
    await svc.buildPlan(CTX, {
      packet: packet(),
      creds: [cred],
      recipientBrief: 'Name: Dana Reed',
      audienceKind: 'individual',
      clientName: null,
      tone: 'professional',
      recipientScopeKeys: [],
    });
    const arg = (llm.complete as jest.Mock).mock.calls[0]![0] as { maxTokens: number };
    expect(arg.maxTokens).toBe(MESSAGE_PLAN_MAX_OUTPUT_TOKENS);
    expect(arg.maxTokens).toBeGreaterThan(2000);
  });
});

// ── String-overlength-only repair ────────────────────────────────────────────
//
// Defect (QA 2026-09-16): MESSAGE_PLAN_JSON_SCHEMA communicates size bounds
// only as prose (raw Claude structured outputs reject minLength/maxLength/
// maxItems), so a substantively correct plan can exceed a bound and fail
// MESSAGE_PLAN_INVALID ("String must contain at most 400 character(s)") with
// no draft. buildPlan now takes exactly ONE targeted repair pass when STRING
// overlength is all that is wrong, re-parsing against the SAME strict schema
// and re-running ALL grounding validation.
describe('string-overlength-only repair', () => {
  const cred = {
    provider: 'openai' as const,
    apiKey: String(123),
    model: 'gpt-5',
    usedTenantKey: false,
    modelOverridden: false,
  };

  const buildRequest = {
    packet: packet(),
    creds: [cred],
    recipientBrief: 'Name: Dana Reed',
    audienceKind: 'individual' as const,
    clientName: null,
    tone: 'professional' as const,
    recipientScopeKeys: [],
    reasoningEffort: 'high' as const,
  };

  /** The valid plan with whyNow[0] inflated past the 400-char bound. */
  function overlengthPlanJson(): string {
    const over = { ...plan() } as { whyNow: string[] };
    over.whyNow = ['The markup is approaching.'.padEnd(401, ' a reason to act now')];
    return JSON.stringify(over);
  }

  function serviceWithLlm(
    impls: Array<() => Promise<{ text: string; usage: unknown }>>,
  ): { svc: MessagePlanService; complete: jest.Mock } {
    let call = 0;
    const complete = jest.fn(() => {
      const fn = impls[Math.min(call, impls.length - 1)]!;
      call += 1;
      return fn();
    });
    const config = { get: () => '' } as never;
    return { svc: new MessagePlanService(config, { complete } as never), complete };
  }

  test('a plan over only the 400-char bound is repaired once, strict-validated, and usage is combined', async () => {
    const { svc, complete } = serviceWithLlm([
      // First pass: overlength whyNow[0] — the defect's shape.
      async () => ({
        text: overlengthPlanJson(),
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      // Repair pass: the SAME plan with the wording condensed.
      async () => ({
        text: JSON.stringify(plan()),
        usage: { inputTokens: 120, outputTokens: 60, cacheReadTokens: 80 },
      }),
    ]);

    const result = await svc.buildPlan(CTX, buildRequest);

    // Bounded at exactly 2 planning calls: original + one repair.
    expect(complete).toHaveBeenCalledTimes(2);

    // The repair call is the SAME pinned identity end to end: same runtime
    // action, provider, credential key, model, max tokens, reasoning effort.
    const [originalArg, repairArg] = complete.mock.calls.map(
      ([a]) =>
        a as {
          runtimeAction: unknown;
          provider: string;
          apiKey: string;
          model: string;
          maxTokens: number;
          reasoningEffort: unknown;
          userStatic: string;
          system: string;
          userVolatile: string;
        },
    ) as [
      {
        runtimeAction: unknown;
        provider: string;
        apiKey: string;
        model: string;
        maxTokens: number;
        reasoningEffort: unknown;
        userStatic: string;
        system: string;
        userVolatile: string;
      },
      {
        runtimeAction: unknown;
        provider: string;
        apiKey: string;
        model: string;
        maxTokens: number;
        reasoningEffort: unknown;
        userStatic: string;
        system: string;
        userVolatile: string;
      },
    ];
    expect(repairArg.provider).toBe(originalArg.provider);
    expect(repairArg.apiKey).toBe(originalArg.apiKey);
    expect(repairArg.model).toBe(originalArg.model);
    expect(repairArg.maxTokens).toBe(originalArg.maxTokens);
    expect(repairArg.maxTokens).toBe(MESSAGE_PLAN_MAX_OUTPUT_TOKENS);
    expect(repairArg.reasoningEffort).toBe(originalArg.reasoningEffort);
    expect(repairArg.runtimeAction).toBe(originalArg.runtimeAction);
    // Same cacheable prefix — only the volatile tail differs.
    expect(repairArg.system).toBe(originalArg.system);
    expect(repairArg.userStatic).toBe(originalArg.userStatic);
    expect(repairArg.userVolatile.startsWith(originalArg.userVolatile)).toBe(true);
    // The repair tail names the bound and carries the invalid plan as DATA.
    expect(repairArg.userVolatile).toContain('exceeded their maximum length');
    expect(repairArg.userVolatile).toContain('whyNow.0');
    expect(repairArg.userVolatile).toContain('<<<EXTERNAL_CONTENT');
    expect(repairArg.userVolatile).toContain('The markup is approaching.');

    // The repaired plan is the REAL validated plan (grounding re-ran on it).
    expect(result.plan.whyNow[0]).toBe('The markup is approaching.');
    // Usage is the honest SUM of both planning calls, cache fields included.
    expect(result.usage).toEqual({
      inputTokens: 220,
      outputTokens: 110,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
    });
  });

  test('a repair that is STILL invalid fails truthfully — no second repair', async () => {
    const { svc, complete } = serviceWithLlm([
      async () => ({ text: overlengthPlanJson(), usage: { inputTokens: 1, outputTokens: 1 } }),
      // The repair also returns an overlength value: the plan stays invalid.
      async () => ({ text: overlengthPlanJson(), usage: { inputTokens: 2, outputTokens: 2 } }),
      async () => {
        throw new Error('must not be called a third time');
      },
    ]);

    await expect(svc.buildPlan(CTX, buildRequest)).rejects.toBeInstanceOf(MessagePlanInvalidError);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test('malformed JSON is never repaired', async () => {
    const { svc, complete } = serviceWithLlm([
      async () => ({ text: 'not json at all', usage: { inputTokens: 1, outputTokens: 1 } }),
      async () => {
        throw new Error('must not repair');
      },
    ]);
    await expect(svc.buildPlan(CTX, buildRequest)).rejects.toBeInstanceOf(MessagePlanInvalidError);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a non-size schema violation (invalid type) is never repaired', async () => {
    const raw = JSON.stringify({ ...plan(), tone: 123 });
    const { svc, complete } = serviceWithLlm([
      async () => ({ text: raw, usage: { inputTokens: 1, outputTokens: 1 } }),
      async () => {
        throw new Error('must not repair');
      },
    ]);
    await expect(svc.buildPlan(CTX, buildRequest)).rejects.toBeInstanceOf(MessagePlanInvalidError);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('eligibility uses the FULL issue list, not parsePlan’s 12-issue slice', async () => {
    // 15 string-overlength issues (>12, past parsePlan's slice) plus one
    // invalid type. The sliced exception would show only size issues; the
    // fresh full safeParse must see the invalid type and refuse repair.
    const pad = (s: string, c: string) => s.padEnd(401, c);
    const over = {
      ...plan(),
      tone: 123, // the non-size issue hiding behind the slice
      whyNow: Array.from({ length: 5 }, () => pad('The markup is approaching.', 'x')),
      clientAsk: Array.from({ length: 5 }, () => pad('A 20-minute meeting.', 'y')),
      whyRecipient: Array.from({ length: 5 }, () => pad('Sits on Armed Services.', 'z')),
    };
    // Prove the fixture really carries 15 string issues and an invalid_type
    // issue beyond slice index 12 — the concrete >12 behavior under test.
    const raw = JSON.stringify(over);
    const probe = messagePlanSchema.safeParse(JSON.parse(raw));
    expect(probe.success).toBe(false);
    if (probe.success) return;
    const sizeIssues = probe.error.issues.filter(
      (i) => i.code === 'too_big' && i.type === 'string' && i.path.length > 0,
    );
    const typeIdx = probe.error.issues.findIndex((i) => i.code === 'invalid_type');
    expect(sizeIssues.length).toBe(15);
    expect(typeIdx).toBeGreaterThan(12);

    const { svc, complete } = serviceWithLlm([
      async () => ({ text: raw, usage: { inputTokens: 1, outputTokens: 1 } }),
      async () => {
        throw new Error('must not repair');
      },
    ]);
    await expect(svc.buildPlan(CTX, buildRequest)).rejects.toBeInstanceOf(MessagePlanInvalidError);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('15 pure string-overlength issues (past the 12-issue slice) still repair', async () => {
    // Proves the eligibility check sees ALL issues: every one of the 15 is a
    // string too_big, so repair fires even though parsePlan's sliced
    // exception only reported the first 12. callToAction stays valid so the
    // issue count is exactly 15.
    const pad = (s: string, c: string) => s.padEnd(401, c);
    const over = {
      ...plan(),
      whyNow: Array.from({ length: 5 }, () => pad('The markup is approaching.', 'a')),
      clientAsk: Array.from({ length: 5 }, () => pad('A 20-minute meeting.', 'b')),
      whyRecipient: Array.from({ length: 5 }, () => pad('Sits on Armed Services.', 'c')),
    };
    const probe = messagePlanSchema.safeParse(over);
    expect(probe.success).toBe(false);
    if (probe.success) return;
    expect(
      probe.error.issues.filter(
        (i) => i.code === 'too_big' && i.type === 'string' && i.path.length > 0,
      ).length,
    ).toBe(15);

    const { svc, complete } = serviceWithLlm([
      async () => ({
        text: JSON.stringify(over),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      async () => ({
        text: JSON.stringify(plan()),
        usage: { inputTokens: 2, outputTokens: 2 },
      }),
    ]);
    const result = await svc.buildPlan(CTX, buildRequest);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.plan.callToAction).toBe('Could we find 20 minutes?');
  });

  test('an array-bound violation is never repaired (dropping entries is not condensing)', async () => {
    // supportedClaims max is 30; fitting that bound means dropping whole
    // claims, which the repair prompt forbids — so it stays an error.
    const many = Array.from({ length: 31 }, () => ({
      claim: 'HR 1234 was referred to Armed Services.',
      sourceIds: ['hr1234-119'],
      asOf: '2026-07-20',
      claimType: 'legislative_status' as const,
    }));
    const { svc, complete } = serviceWithLlm([
      async () => ({
        text: JSON.stringify({ ...plan(), supportedClaims: many }),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      async () => {
        throw new Error('must not repair');
      },
    ]);
    await expect(svc.buildPlan(CTX, buildRequest)).rejects.toBeInstanceOf(MessagePlanInvalidError);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('an overlength plan that ALSO cites an unknown source is never repaired', async () => {
    // Mixed size + grounding failure: condensing wording cannot fix a bad
    // citation, so this must stay a truthful error.
    const over = {
      ...plan(),
      whyNow: ['The markup is approaching.'.padEnd(401, ' a reason to act now')],
      supportedClaims: [
        {
          claim: 'S. 999 advanced.',
          sourceIds: ['s999-does-not-exist'],
          asOf: '2026-07-20',
          claimType: 'legislative_status' as const,
        },
      ],
    };
    const { svc, complete } = serviceWithLlm([
      async () => ({
        text: JSON.stringify(over),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      async () => {
        throw new Error('must not repair');
      },
    ]);
    await expect(svc.buildPlan(CTX, buildRequest)).rejects.toBeInstanceOf(MessagePlanInvalidError);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a valid plan never triggers any repair call', async () => {
    const { svc, complete } = serviceWithLlm([
      async () => ({
        text: JSON.stringify(plan()),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      async () => {
        throw new Error('must not repair');
      },
    ]);
    const result = await svc.buildPlan(CTX, buildRequest);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

