import { describe, expect, it } from '@jest/globals';
import type { AssuredClaim, ClaimLedger } from '../assurance/claim-ledger';
import type { DomainEvidencePlan } from '../assurance/evidence-plan';
import type { DecisionProvider, EvidenceDecision, EvidenceOutcome } from '../jev/decision-contract';
import { assembleAnswer } from './assemble';
import { deriveRequirement, planRemedy } from './plan-remedy';
import { runRepairLoop } from './run-repair';
import { ReplayToolExecutor, toolRecordingKey, type ToolExecutor } from './tool-executor';
import type { RepairBudget, RepairEvidence, RepairToolResult } from './types';

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
    expect(result.reply).toContain('repair budget was exhausted');
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
