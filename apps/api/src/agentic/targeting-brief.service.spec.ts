import { TargetingBriefService, type TargetingBriefTrigger } from './targeting-brief.service.js';
import type { ChokepointResult } from '../intelligence/chokepoint/chokepoint.types.js';

/**
 * TargetingBriefService.generate — Phase 1 M5.2 ("the P1 agentic headline")
 * + M5-B success criterion: "a targeting brief on a real bill (both rails)
 * names ONLY members whose roles/districts the deterministic validator
 * confirms; a seeded hallucinated member is dropped and logged." Two
 * INDEPENDENT drop layers are exercised here: GroundedJson's own citation
 * check (unknown evidence id) and TargetingValidatorService's re-derivation
 * from source-of-truth tables (belt and suspenders).
 */

const TRIGGER: TargetingBriefTrigger = {
  alertId: 'alert-1',
  tenantId: 't1',
  clientId: 'client-1',
  billKey: '119-hr-8800',
  billTitle: 'National Defense Manufacturing Act',
};

const CHOKEPOINT: ChokepointResult = {
  billKey: '119-hr-8800',
  jurisdiction: 'federal',
  referredCommittee: { id: 'hsas00', name: 'Armed Services' },
  chair: { id: 'D000001', name: 'Rep. Chair Person', chamber: 'house', party: 'R', role: 'Chair' },
  viceChair: null,
  rankingMember: {
    id: 'D000002',
    name: 'Rep. Ranking Person',
    chamber: 'house',
    party: 'D',
    role: 'Ranking Member',
  },
  rulesGate: null,
  chamberLeadership: null,
  sponsor: { id: 'D000003', name: 'Rep. Sponsor Person', chamber: 'house', party: 'R', role: null },
  companionStatus: null,
  deadlineRisk: null,
  survivalScore: 0.7,
  survivalBand: 'likely-advances',
  survivalConfidence: 'normal',
  footprintOverlap: [
    {
      memberId: 'D000001',
      memberName: 'Rep. Chair Person',
      memberRole: 'Chair',
      facilityId: 'fac-1',
      facilityName: 'Acme Plant',
    },
  ],
};

function makeDeps(opts: {
  llmInputs: Array<{ input: unknown }>;
  validatorDrops?: string[]; // memberIds the fake validator rejects
}) {
  let call = 0;
  const llm = {
    completeJson: async () => ({}),
    completeWithSchema: async () => {
      const r = opts.llmInputs[Math.min(call, opts.llmInputs.length - 1)];
      call += 1;
      return { input: r!.input, usage: { inputTokens: 50, outputTokens: 20 } };
    },
  };

  const aiRuns: unknown[] = [];
  const aiUsageEvents: unknown[] = [];
  const prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiRun: { create: async (args: unknown) => (aiRuns.push(args), args) },
        aiUsageEvent: { create: async (args: unknown) => (aiUsageEvents.push(args), args) },
      }),
    withSystem: async (fn: (tx: unknown) => unknown) => fn({}),
  };

  const chokepoint = { forBill: async () => CHOKEPOINT };

  const drops = new Set(opts.validatorDrops ?? []);
  const validator = {
    validateMemberClaims: async (
      _tenantId: string,
      _clientId: string,
      claims: Array<{ memberId: string }>,
    ) => ({
      valid: claims.filter((c) => !drops.has(c.memberId)),
      dropped: claims
        .filter((c) => drops.has(c.memberId))
        .map((claim) => ({ claim, reason: 'role_not_confirmed' as const })),
    }),
  };

  const service = new TargetingBriefService(
    prisma as never,
    chokepoint as never,
    validator as never,
  );
  return { service, llm, aiRuns, aiUsageEvents };
}

const CREDENTIAL = { model: 'claude-sonnet-5', usedTenantKey: false };

describe('TargetingBriefService.generate', () => {
  it('PINNED: a brief naming only real roster members passes both gates, meters usage, and writes ai_run', async () => {
    const { service, llm, aiRuns, aiUsageEvents } = makeDeps({
      llmInputs: [
        {
          input: {
            targets: [
              {
                memberId: 'D000001',
                priority: 'primary',
                rationale: 'D000001::Chair of the referred committee — the key gatekeeper.',
                evidenceIds: ['D000001'],
              },
            ],
            recommendedSequence: ['Engage the chair first'],
          },
        },
      ],
    });

    const out = await service.generate(TRIGGER, llm as never, CREDENTIAL);

    expect(out.targets).toHaveLength(1);
    expect(out.targets[0]?.memberId).toBe('D000001');
    expect(out.droppedByGrounding).toBe(0);
    expect(out.droppedByValidator).toBe(0);
    expect(out.materiality).toBe('high'); // a primary target is present
    expect(out.qaStatus).toBe('pending'); // high materiality -> interim QA hold
    expect(aiUsageEvents).toHaveLength(1);
    expect((aiUsageEvents[0] as { data: Record<string, unknown> }).data).toMatchObject({
      workflow: 'intel_targeting',
      inputTokens: 50,
      outputTokens: 20,
    });
    expect(aiRuns).toHaveLength(1);
    expect((aiRuns[0] as { data: Record<string, unknown> }).data).toMatchObject({
      workflow: 'intel_targeting',
      rail: 'federal',
      subjectType: 'bill',
      subjectKey: '119-hr-8800',
      validationStatus: 'passed',
      qaStatus: 'pending',
      status: 'ok',
    });
  });

  it('PINNED (M5-B, layer 1 — GroundedJson): a target citing an evidence id NOT in the roster is dropped by the citation check', async () => {
    const { service, llm } = makeDeps({
      llmInputs: [
        {
          input: {
            targets: [
              {
                memberId: 'Z999999',
                priority: 'primary',
                rationale: 'Z999999::Chair of the committee (hallucinated).',
                evidenceIds: ['Z999999-NOT-A-REAL-EVIDENCE-ID'],
              },
            ],
            recommendedSequence: [],
          },
        },
      ],
    });

    const out = await service.generate(TRIGGER, llm as never, CREDENTIAL);

    expect(out.targets).toHaveLength(0);
    expect(out.droppedByGrounding).toBe(1);
  });

  it('PINNED (M5-B, layer 2 — TargetingValidatorService): a target that passes citation but fails the INDEPENDENT re-derivation is dropped', async () => {
    // Cites a REAL roster evidence id (passes GroundedJson) but the fake
    // validator (standing in for congress_committee_membership) rejects it —
    // proving the second, independent gate has real teeth on its own.
    const { service, llm } = makeDeps({
      llmInputs: [
        {
          input: {
            targets: [
              {
                memberId: 'D000002',
                priority: 'secondary',
                rationale: 'D000002::Ranking member, worth a courtesy call.',
                evidenceIds: ['D000002'],
              },
            ],
            recommendedSequence: [],
          },
        },
      ],
      validatorDrops: ['D000002'],
    });

    const out = await service.generate(TRIGGER, llm as never, CREDENTIAL);

    expect(out.targets).toHaveLength(0);
    expect(out.droppedByGrounding).toBe(0);
    expect(out.droppedByValidator).toBe(1);
  });

  it('a secondary-only brief (no primary target) is low materiality and approved immediately (no QA hold)', async () => {
    const { service, llm } = makeDeps({
      llmInputs: [
        {
          input: {
            targets: [
              {
                memberId: 'D000002',
                priority: 'secondary',
                rationale: 'D000002::Ranking member, worth a courtesy call.',
                evidenceIds: ['D000002'],
              },
            ],
            recommendedSequence: [],
          },
        },
      ],
    });

    const out = await service.generate(TRIGGER, llm as never, CREDENTIAL);
    expect(out.materiality).toBe('low');
    expect(out.qaStatus).toBe('approved');
  });

  it('writes ai_run with validationStatus=skipped (never calls the LLM) when the bill has no resolvable chokepoint roster', async () => {
    const chokepoint = {
      forBill: async () => ({
        ...CHOKEPOINT,
        chair: null,
        viceChair: null,
        rankingMember: null,
        chamberLeadership: null,
        sponsor: null,
        footprintOverlap: [],
      }),
    };
    const prisma = {
      withTenant: async (_t: string, fn: (tx: unknown) => unknown) =>
        fn({
          aiRun: { create: async (a: unknown) => a },
          aiUsageEvent: { create: async (a: unknown) => a },
        }),
      withSystem: async (fn: (tx: unknown) => unknown) => fn({}),
    };
    const validator = { validateMemberClaims: async () => ({ valid: [], dropped: [] }) };
    const llmSpy = jest.fn();
    const llm = { completeJson: async () => ({}), completeWithSchema: llmSpy };

    const service = new TargetingBriefService(
      prisma as never,
      chokepoint as never,
      validator as never,
    );
    const out = await service.generate(TRIGGER, llm as never, CREDENTIAL);

    expect(out.targets).toHaveLength(0);
    expect(out.validationStatus).toBe('passed');
    expect(llmSpy).not.toHaveBeenCalled();
  });
});
