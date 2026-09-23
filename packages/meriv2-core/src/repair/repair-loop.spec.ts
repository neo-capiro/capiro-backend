import { describe, expect, it } from '@jest/globals';
import type { AssuredClaim, ClaimLedger } from '../assurance/claim-ledger';
import type { DomainEvidencePlan } from '../assurance/evidence-plan';
import type { DecisionProvider, EvidenceDecision, EvidenceOutcome } from '../jev/decision-contract';
import { assembleAnswer } from './assemble';
import { deriveRequirement, planRemedy } from './plan-remedy';
import { OMITTED_CLAIM_NOTE, REPAIR_BUDGET_LIMITATION, runRepairLoop } from './run-repair';
import { ReplayToolExecutor, toolRecordingKey, type ToolExecutor } from './tool-executor';
import type { RepairBudget, RepairEvidence, RepairToolCall, RepairToolResult } from './types';

const providerMeta = { name: 'stub', model: 'recorded', questionVersion: 'claim_support.v1' };
const unsupported = outcome('insufficient_evidence');
const supported = outcome('supported');
const plan: DomainEvidencePlan = {
  version: 'ga-evidence-plan-v1', requestCategories: ['general_background'], jurisdictions: [],
  requirements: [{ id: 'general.primary', claimCategory: 'general_background', level: 'required', evidenceClass: 'official_government_data', toolFamilies: ['search_official_sources'], freshness: 'same_turn', reason: 'test', requiredFields: ['value', 'asOf'] }],
  requiredRequirementIds: ['general.primary'], optionalRequirementIds: [], supplementalRequirementIds: [], unresolvedFrameFields: [], incomplete: false,
};
const registry = { get: (name: string) => name === 'search_official_sources' ? { readOnly: true } : undefined };
const budget: RepairBudget = { maxPasses: 1, maxToolCalls: 2, maxMs: 5_000, maxInputTokens: 1_000 };
const exactRequirementCases: Array<['mismatch' | 'absent', 'contradiction' | 'missing_evidence']> = [
  ['mismatch', 'contradiction'],
  ['absent', 'missing_evidence'],
];

function claim(text = 'The official total is 20.'): AssuredClaim {
  return { id: 'claim-1', text, type: 'fact', category: 'general_background', sourceIds: [], primarySourcePresent: false, confidence: 'low', unsupportedReason: 'missing' };
}
function ledger(): { version: number; ledger: ClaimLedger; passages: Record<string, string> } {
  return { version: 1, passages: {}, ledger: { version: 'ga-claim-ledger-v1', claims: [claim()], evidence: [], unsupportedClaimIds: ['claim-1'], conflictedClaimIds: [], highRiskUnsupportedClaimIds: [], requiredEvidenceGaps: ['general.primary'], hash: 'fixture' } };
}
function evidence(passage = 'The authoritative total is 25.'): RepairEvidence {
  return { id: 'evidence-1', sourceType: 'official', sourceId: 'record-1', evidenceClass: 'official_government_data', primary: true, authoritative: true, requirementIds: ['general.primary'], passage, asOf: '2026-09-22' };
}
function outcome(value: EvidenceOutcome): EvidenceDecision {
  return { kind: 'outcome', outcome: value, probabilities: { supported: value === 'supported' ? 1 : 0, contradicted: 0, insufficient_evidence: value === 'insufficient_evidence' ? 1 : 0, conflicting_evidence: value === 'conflicting_evidence' ? 1 : 0 }, confidence: 1, reasonCodes: [], evidenceIds: [], provider: providerMeta, latencyMs: 0 };
}
function decisionProvider(rule: (text: string) => EvidenceDecision = () => supported): DecisionProvider {
  return { name: 'stub', available: () => true, async assess(envelope) { return rule(envelope.claimText); } };
}
function executor(result: RepairToolResult, after?: () => void): ToolExecutor & { calls: number } {
  return { calls: 0, async execute() { this.calls += 1; after?.(); return result; } };
}
function base(overrides: Partial<Parameters<typeof runRepairLoop>[0]> = {}) {
  return { reply: 'The official total is 20. Other supported context remains unchanged.', claims: [claim()], decisions: { 'claim-1': unsupported }, ledger: ledger(), providers: { decision: decisionProvider() }, executor: executor({ ok: true, evidence: [evidence()] }), generate: async () => ({ replacementText: 'The official total is 25.', citedEvidenceIds: ['evidence-1'] }), budget, evidencePlan: plan, toolRegistry: registry, tenantId: '11111111-1111-4111-8111-111111111111', ...overrides };
}

describe('repair replay scenarios', () => {
  it('corrects a recoverable factual error and rechecks it', async () => {
    const result = await runRepairLoop(base());
    expect(result.status).toBe('corrected');
    expect(result.reply).toContain('total is 25');
    expect(result.citations).toEqual(['evidence-1']);
  });

  it('qualifies a missing exact transcript without asking for re-upload', async () => {
    const c = claim('The transcript says the chair promised action.');
    const result = await runRepairLoop(base({ reply: c.text, claims: [c], ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } }, executor: executor({ ok: false, state: 'document_unavailable', reason: 'transcript unavailable' }) }));
    expect(result.status).toBe('qualified');
    expect(result.reply).toContain('attach the named transcript');
    expect(result.reply).not.toMatch(/re-?upload/i);
  });

  it.each([
    ['known name', 'hearing-2026-09-21.txt', "attach the 'hearing-2026-09-21.txt' transcript"],
    ['unknown name', undefined, 'attach the named transcript'],
  ])('requests a specific unavailable document when its name is %s', async (_label, missingDocumentName, expected) => {
    const c = claim('The transcript says the chair promised action.');
    const result = await runRepairLoop(base({
      reply: c.text,
      claims: [c],
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } },
      executor: executor({ ok: false, state: 'document_unavailable', reason: 'transcript unavailable' }),
      missingDocumentName,
    }));
    expect(result.reply).toContain(expected);
  });

  it('preserves unrelated supported content while requesting the named document', async () => {
    const c = claim('The transcript says the chair promised action.');
    const result = await runRepairLoop(base({
      reply: `${c.text} The bill passed the House.`,
      claims: [c],
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } },
      executor: executor({ ok: false, state: 'document_unavailable', reason: 'transcript unavailable' }),
      missingDocumentName: 'hearing.txt',
    }));
    expect(result.reply).toContain("attach the 'hearing.txt' transcript");
    expect(result.reply).toContain('The bill passed the House.');
  });

  it('leaves supported unrelated claims untouched during an outage', async () => {
    const result = await runRepairLoop(base({ reply: 'The official total is 20. The bill passed the House.', executor: executor({ ok: false, state: 'retrieval_failed', reason: 'source outage' }) }));
    expect(result.reply).toContain('The bill passed the House.');
  });

  it('assesses a newly introduced material assertion and qualifies the section', async () => {
    const result = await runRepairLoop(base({ generate: async () => ({ replacementText: 'The official total is 25. It was approved in 2025.', citedEvidenceIds: ['evidence-1'] }), providers: { decision: decisionProvider((text) => text.includes('2025') ? unsupported : supported) } }));
    expect(result.status).toBe('omitted');
    expect(result.trace.find((item) => item.type === 'recheck')?.detail).toMatchObject({ supported: false });
  });

  it('does not execute an identical failed retrieval twice', async () => {
    const failing = executor({ ok: false, state: 'retrieval_failed', reason: 'outage' });
    const result = await runRepairLoop(base({ budget: { ...budget, maxPasses: 2 }, executor: failing }));
    expect(failing.calls).toBe(1);
    expect(result.trace).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'remedy_refused', detail: { reason: 'failed_call_deduped' } })]));
  });

  it('cancels before a late replacement can win', async () => {
    const controller = new AbortController();
    const result = await runRepairLoop(base({ signal: controller.signal, executor: executor({ ok: true, evidence: [evidence()] }, () => controller.abort()) }));
    expect(result.status).toBe('cancelled');
    expect(result.reply).toContain('total is 20');
  });

  it('returns a useful qualification when the budget is exhausted', async () => {
    const result = await runRepairLoop(base({ budget: { ...budget, maxToolCalls: 0 } }));
    expect(result.status).toBe('budget_exhausted');
    expect(result.reply).toContain('The official total is 20.');
    expect(result.reply).toContain(REPAIR_BUDGET_LIMITATION);
    expect(result.reply).not.toMatch(/repair budget/i);
  });

  it('preserves a dated source disagreement instead of choosing silently', async () => {
    const conflict = outcome('conflicting_evidence');
    const result = await runRepairLoop(base({ decisions: { 'claim-1': conflict }, providers: { decision: decisionProvider(() => conflict) }, generate: async () => ({ replacementText: 'The 2025 record says 20, while the 2026 authoritative record says 25.', citedEvidenceIds: ['evidence-1'] }) }));
    expect(result.status).toBe('omitted');
    expect(result.trace.some((item) => item.type === 'recheck')).toBe(true);
  });
});

describe('repair safety primitives', () => {
  it.each(exactRequirementCases)('maps deterministic exact %s to %s', (result, kind) => {
    const requirement = deriveRequirement({
      decision: supported, claim: claim(), evidencePlan: plan,
      envelope: { envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'claim-1', claimText: claim().text,
        claimKind: 'fact', claimCategory: 'general_background', tenantId: 't', clientId: null,
        scopeQualifiers: [], asOf: null, sources: [] },
      deterministic: { exact: { kind: 'amount', claimValue: null, evidenceValues: [], result, detail: '' },
        freshness: { state: 'fresh', ageDays: 0, basis: 'publishedAt', reason: '' }, houseSenateComplete: true },
    });
    expect(requirement?.kind).toBe(kind);
  });

  it('routes stale deterministic evidence to a current-status refresh', () => {
    const requirement = { claimId: 'c', kind: 'stale_status' as const, evidenceClass: 'official_government_data' as const,
      toolFamilies: ['search_official_sources'], requiredFields: [], freshness: 'same_turn' as const };
    expect(planRemedy(requirement, { tenantId: 't', evidencePlan: plan, toolRegistry: registry }).remedy)
      .toEqual(expect.objectContaining({ kind: 'refresh_status', toolCall: expect.objectContaining({ args: expect.objectContaining({ route: 'current_status' }) }) }));
  });

  it('fails closed for unknown and mutating tools', () => {
    const requirement = { claimId: 'c', kind: 'missing_evidence' as const, evidenceClass: 'official_government_data' as const, toolFamilies: ['write_record'], requiredFields: [] };
    expect(planRemedy(requirement, { tenantId: 't', evidencePlan: plan, toolRegistry: { get: () => ({ readOnly: false }) } }).reason).toBe('tool_not_read_only');
    expect(planRemedy({ ...requirement, toolFamilies: ['unknown'] }, { tenantId: 't', evidencePlan: plan, toolRegistry: { get: () => undefined } }).reason).toBe('unknown_tool');
  });

  it('replay misses are retrieval failures and stale revisions cannot win', async () => {
    const call = { name: 'search_official_sources', args: { q: 'x' } };
    const replay = new ReplayToolExecutor([{ key: toolRecordingKey(call), result: { ok: true, evidence: [evidence()] } }]);
    await expect(replay.execute({ name: call.name, args: { q: 'miss' } }, {})).resolves.toMatchObject({ ok: false, state: 'retrieval_failed' });
    const assembled = assembleAnswer({ baseReply: 'Old.', ledgerVersion: ledger(), revisions: [{ claimId: 'c', originalText: 'Old.', replacementText: 'Late.', sourceIds: [], ledgerVersion: 0, dependentSentences: [], outcome: 'corrected' }] });
    expect(assembled.reply).toBe('Old.');
    expect(assembled.trace[0]?.type).toBe('stale_revision_rejected');
  });
});

describe('repair correctness fixes', () => {
  const firstText = 'The official total is 20.';
  const secondText = 'Senate funding is 30.';
  function evidenceFor(id: string, passage: string): RepairEvidence {
    return { ...evidence(passage), id, sourceId: `record-${id}` };
  }
  function twoClaimBase(overrides: Partial<Parameters<typeof runRepairLoop>[0]> = {}) {
    const first = claim(firstText);
    const second: AssuredClaim = { ...claim(secondText), id: 'claim-2' };
    const byClaim: Record<string, RepairEvidence> = {
      'claim-1': evidenceFor('evidence-1', 'The authoritative total is 25.'),
      'claim-2': evidenceFor('evidence-2', 'Senate funding is 35.'),
    };
    const calls: RepairToolCall[] = [];
    const exec: ToolExecutor = {
      async execute(call) {
        calls.push(call);
        const claimId = (call.args.claimIds as string[])[0]!;
        return { ok: true, evidence: [byClaim[claimId]!] };
      },
    };
    return {
      calls,
      input: base({
        reply: `${firstText} ${secondText} Other supported context remains unchanged.`,
        claims: [first, second],
        decisions: { 'claim-1': unsupported, 'claim-2': unsupported },
        ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [first, second], unsupportedClaimIds: ['claim-1', 'claim-2'] } },
        executor: exec,
        generate: async ({ claim: target, evidence: items }) => ({
          replacementText: target.id === 'claim-1' ? 'The official total is 25.' : 'Senate funding is 35.',
          citedEvidenceIds: items.map((item) => item.id),
        }),
        ...overrides,
      }),
    };
  }

  it('applies every corrected claim when later evidence bumps the ledger version', async () => {
    const result = await runRepairLoop(twoClaimBase().input);
    expect(result.status).toBe('corrected');
    expect(result.reply).toBe('The official total is 25. Senate funding is 35. Other supported context remains unchanged.');
    expect(result.applied?.map((item) => item.claimId)).toEqual(['claim-1', 'claim-2']);
    expect(result.trace.some((item) => item.type === 'stale_revision_rejected')).toBe(false);
    expect(result.citations).toEqual(['evidence-1', 'evidence-2']);
  });

  it('reports one terminal outcome per attempted claim and derives the turn status from all of them', async () => {
    const third: AssuredClaim = { ...claim('Award funding is 40.'), id: 'claim-3' };
    const { input } = twoClaimBase();
    const delegate = input.executor;
    const result = await runRepairLoop({
      ...input,
      reply: `${input.reply} ${third.text}`,
      claims: [...input.claims, third],
      decisions: { ...(input.decisions as Record<string, EvidenceDecision>), 'claim-3': unsupported },
      budget: { ...budget, maxToolCalls: 3 },
      executor: {
        async execute(call, options) {
          if ((call.args.claimIds as string[])[0] === 'claim-3') return { ok: true, evidence: [] };
          return delegate.execute(call, options);
        },
      },
    });
    expect(result.status).toBe('partial');
    expect(result.summary).toBe('partial');
    expect(result.claimOutcomes).toEqual([
      { claimId: 'claim-1', outcome: 'corrected' },
      { claimId: 'claim-2', outcome: 'corrected' },
      { claimId: 'claim-3', outcome: 'unresolved', reason: 'no_new_evidence' },
    ]);
    expect(result.reply).toContain('Award funding is 40.');
  });

  it('still rejects a revision whose cited evidence changed after it was made', () => {
    const versioned = { ...ledger(), version: 3, evidenceVersions: { 'evidence-1': 3 }, ledger: { ...ledger().ledger, evidence: [evidence()] } };
    const assembled = assembleAnswer({
      baseReply: 'Old.', ledgerVersion: versioned,
      revisions: [{ claimId: 'c', originalText: 'Old.', replacementText: 'Late.', sourceIds: ['evidence-1'], ledgerVersion: 2, dependentSentences: [], outcome: 'corrected' }],
    });
    expect(assembled.reply).toBe('Old.');
    expect(assembled.applied).toEqual([]);
    expect(assembled.trace[0]?.detail).toMatchObject({ reason: 'evidence_changed:evidence-1' });
  });

  it('returns the original reply when aborted after an earlier claim was already revised', async () => {
    const controller = new AbortController();
    const { input } = twoClaimBase({ signal: controller.signal });
    const delegate = input.executor;
    let executions = 0;
    const result = await runRepairLoop({
      ...input,
      executor: {
        async execute(call, options) {
          executions += 1;
          if (executions === 2) controller.abort();
          return delegate.execute(call, options);
        },
      },
    });
    expect(result.status).toBe('cancelled');
    expect(result.reply).toBe(input.reply);
    expect(result.applied).toEqual([]);
  });

  it('adds one claim-local note and leaves the remaining flagged sentences untouched when the budget is exhausted', async () => {
    const { input } = twoClaimBase({ budget: { ...budget, maxToolCalls: 0 } });
    const result = await runRepairLoop(input);
    expect(result.status).toBe('budget_exhausted');
    expect(result.reply).toBe(`${firstText} ${REPAIR_BUDGET_LIMITATION} ${secondText} Other supported context remains unchanged.`);
    expect(result.reply.match(/Evidence limitation/g)).toHaveLength(1);
    expect(result.reply).not.toMatch(/budget/i);
  });

  it('never deletes a sentence the ledger marks supported; unsupported exact values leave a one-clause note', async () => {
    const c = claim('The official total is $20M.');
    const refusing = { get: () => ({ readOnly: false }) };
    const cited: AssuredClaim = { ...c, sourceIds: ['evidence-0'], unsupportedReason: undefined };
    const kept = await runRepairLoop(base({
      reply: `${c.text} The bill passed the House.`, claims: [cited], toolRegistry: refusing,
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [cited], evidence: [evidenceFor('evidence-0', 'The total is $20M.')], unsupportedClaimIds: [] } },
    }));
    expect(kept.status).toBe('qualified');
    expect(kept.reply).toContain('The official total is $20M');
    expect(kept.reply).toContain('The bill passed the House.');
    expect(kept.applied?.[0]).toMatchObject({ outcome: 'qualified', reason: 'remedy_refused' });

    const omitted = await runRepairLoop(base({
      reply: `${c.text} The bill passed the House.`, claims: [c], toolRegistry: refusing,
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } },
    }));
    expect(omitted.status).toBe('omitted');
    expect(omitted.reply).toBe(`${OMITTED_CLAIM_NOTE} The bill passed the House.`);
  });

  it('keeps internal failure codes out of the customer-facing limitation', async () => {
    const c = claim('The official total is stated.');
    const result = await runRepairLoop(base({
      reply: `${c.text} The bill passed the House.`, claims: [c],
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } },
      executor: executor({ ok: false, state: 'retrieval_failed', reason: 'no_concrete_route' }),
    }));
    expect(result.reply).not.toContain('no_concrete_route');
    expect(result.reply).toContain('the available evidence does not resolve it');
    expect(result.reply).toContain('The bill passed the House.');
  });

  it('routes a document claim to the referenced document and names it in the request', async () => {
    const c = claim('The transcript says the chair promised action.');
    const calls: RepairToolCall[] = [];
    const exec: ToolExecutor = {
      async execute(call) {
        calls.push(call);
        return { ok: false, state: 'document_unavailable', reason: 'document_content_unavailable' };
      },
    };
    const result = await runRepairLoop(base({
      reply: `${c.text} The bill passed the House.`, claims: [c],
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } },
      evidencePlan: { ...plan, requirements: [{ ...plan.requirements[0]!, toolFamilies: ['read_client_documents'] }] },
      toolRegistry: { get: (name: string) => name === 'read_client_documents' ? { readOnly: true } : undefined },
      executor: exec,
      documentReferences: [{ id: 'doc-7', filename: 'hearing.txt', readable: true, contentState: 'ready' }],
    }));
    expect(calls).toEqual([expect.objectContaining({
      name: 'read_client_documents',
      args: expect.objectContaining({ documentId: 'doc-7' }),
    })]);
    expect(result.reply).toBe(`To confirm “${c.text}”, attach the 'hearing.txt' transcript. The bill passed the House.`);
    expect(result.applied?.[0]).toMatchObject({ outcome: 'qualified', reason: 'document_unavailable' });
  });

  it('requests a document the turn already knows is unreadable without spending a tool call', async () => {
    const c = claim('The transcript says the chair promised action.');
    const exec = executor({ ok: true, evidence: [evidence()] });
    const result = await runRepairLoop(base({
      reply: c.text, claims: [c],
      ledger: { ...ledger(), ledger: { ...ledger().ledger, claims: [c] } },
      evidencePlan: { ...plan, requirements: [{ ...plan.requirements[0]!, toolFamilies: ['read_client_documents'] }] },
      toolRegistry: { get: () => ({ readOnly: true }) },
      executor: exec,
      documentReferences: [{ id: 'doc-7', filename: 'hearing.txt', readable: false, contentState: 'metadata_only' }],
    }));
    expect(exec.calls).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.reply).toContain("attach the 'hearing.txt' transcript");
  });

  it('counts revision-model tokens separately from recheck tokens', async () => {
    const approved = outcome('supported');
    const result = await runRepairLoop(base({
      generate: async () => ({ replacementText: 'The official total is 25.', citedEvidenceIds: ['evidence-1'], usage: { inputTokens: 300, outputTokens: 40 } }),
      providers: { decision: decisionProvider(() => ({ ...approved, usage: { inputTokens: 120, outputTokens: 5 } })) },
    }));
    expect(result.tokens).toEqual({ revisionInput: 300, revisionOutput: 40, recheckInput: 120 });
    expect(result.inputTokens).toBe(420);
  });

  it('derives a missing-evidence requirement for a chamber comparison lacking one figure', () => {
    const requirement = deriveRequirement({
      decision: supported, claim: claim('House HASC provided $42M versus Senate SASC at $43M.'), evidencePlan: plan,
      envelope: { envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'claim-1', claimText: 'x',
        claimKind: 'fact', claimCategory: 'general_background', tenantId: 't', clientId: null,
        scopeQualifiers: [], asOf: null, sources: [] },
      deterministic: { exact: { kind: 'amount', claimValue: null, evidenceValues: [], result: 'match', detail: '' },
        freshness: { state: 'fresh', ageDays: 0, basis: 'publishedAt', reason: '' }, houseSenateComplete: false },
    });
    expect(requirement?.kind).toBe('missing_evidence');
  });
});
