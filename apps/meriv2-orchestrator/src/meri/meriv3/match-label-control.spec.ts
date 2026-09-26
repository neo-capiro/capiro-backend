import type { AssuredEvidence, ClientFitProvider, MatchEligibility } from '@capiro/meriv2-core';
import { applyMatchLabelControl, createClientFitEvaluator, matchLabelEvent } from './match-label-control.js';

const evidence: AssuredEvidence[] = [{
  id: 'opp-1', sourceType: 'search_procurement_forecasts', sourceId: 'opp-1',
  evidenceClass: 'official_government_data', title: 'Open opportunity', primary: true,
  authoritative: true, requirementIds: [],
}];
const citations = [{ n: 1, id: 'opp-1', type: 'opportunity', title: 'Open opportunity', url: null,
  snippet: 'Open sustainment need.', tool: 'search_procurement_forecasts' }];

describe('match label control', () => {
  it('is byte-identical and does no evaluation when off', async () => {
    const reply = 'Direct match: Pursue secure sustainment [1].';
    let calls = 0;
    const result = await applyMatchLabelControl({ mode: 'off', reply, citations, evidence, evaluate: async () => {
      calls += 1; return { category: 'explicit_linkage', confidence: 1, jevUsed: true };
    } });
    expect(result.reply).toBe(reply);
    expect(calls).toBe(0);
  });

  it('keeps shadow output unchanged and emits counts only', async () => {
    const reply = 'Direct match: Pursue secure sustainment [1].';
    const result = await applyMatchLabelControl({ mode: 'shadow', reply, citations, evidence });
    expect(result.reply).toBe(reply);
    expect(matchLabelEvent(result, 4)).toMatchObject({ findings: 1, assertedTiers: { direct_match: 1 },
      downgraded: 1, eligibilityStatuses: { unknown: 1 }, jevUsed: false, latencyMs: 4, registryVersion: 'jev-task-registry.v5' });
    expect(JSON.stringify(matchLabelEvent(result, 4))).not.toContain('secure sustainment');
  });

  it('reports unknown eligibility in shadow without changing the reply', async () => {
    const client: AssuredEvidence = { ...evidence[0]!, id: 'client-1', sourceId: 'client-1',
      sourceType: 'read_client_documents', evidenceClass: 'client_approved_context', title: 'Client capability' };
    const reply = 'Direct match: Pursue secure sustainment [1] [2].';
    const result = await applyMatchLabelControl({ mode: 'shadow', reply,
      citations: [...citations, { ...citations[0]!, n: 2, id: 'client-1', tool: 'read_client_documents' }],
      evidence: [...evidence, client], evaluate: async () => ({ category: 'explicit_linkage', confidence: 0.9, jevUsed: true }),
    });
    expect(result.reply).toBe(reply);
    expect(result.derived[0]).toMatchObject({ label: 'explicit_linkage', eligibility: 'unknown' });
    expect(matchLabelEvent(result, 1)).toMatchObject({ eligibilityStatuses: { unknown: 1 } });
  });

  const eligibilityCases: Array<[MatchEligibility, 'unknown' | 'failed' | 'satisfied', string, string | null]> = [
    [{ mandatoryRequirementsKnown: false, mandatoryRequirementsSatisfied: false }, 'unknown', 'Direct match:', 'Eligibility has not been assessed'],
    [{ mandatoryRequirementsKnown: true, mandatoryRequirementsSatisfied: false }, 'failed', 'Conditional niche:', 'conditional relationship'],
    [{ mandatoryRequirementsKnown: true, mandatoryRequirementsSatisfied: true }, 'satisfied', 'Direct match:', null],
  ];
  it.each(eligibilityCases)('enforce distinguishes eligibility state %s', async (eligibility, status, expectedLabel, expectedCopy) => {
    const client: AssuredEvidence = { ...evidence[0]!, id: 'client-1', sourceId: 'client-1',
      sourceType: 'read_client_documents', evidenceClass: 'client_approved_context', title: 'Client capability' };
    const result = await applyMatchLabelControl({ mode: 'enforce', reply: 'Direct match: Pursue secure sustainment [1] [2].',
      citations: [...citations, { ...citations[0]!, n: 2, id: 'client-1', tool: 'read_client_documents' }],
      evidence: [...evidence, client], eligibility,
      evaluate: async () => ({ category: 'explicit_linkage', confidence: 0.9, jevUsed: true }),
    });
    expect(result.derived[0]).toMatchObject({ label: status === 'failed' ? 'conditional_linkage' : 'explicit_linkage', eligibility: status });
    expect(result.reply).toContain(expectedLabel);
    if (expectedCopy) expect(result.reply).toContain(expectedCopy);
    else expect(result.reply).not.toContain('Eligibility has not been assessed');
  });

  it('downgrades an overstated direct match but preserves the recommendation', async () => {
    const result = await applyMatchLabelControl({
      mode: 'enforce', reply: 'Direct match: Pursue secure sustainment [1].', citations, evidence,
      evaluate: async () => ({ category: 'conditional_linkage', confidence: 0.9, jevUsed: true }),
    });
    expect(result.reply).toContain('Conditional niche: Pursue secure sustainment [1].');
    expect(result.reply).toContain('conditional relationship');
  });

  it('uses the task-specific category answer to change the derived outcome', async () => {
    const provider = { name: 'jev-client-fit', available: () => true, assess: jest.fn(async () => ({
      kind: 'outcome' as const,
      category: { value: 'adjacency' as const, confidence: 0.91,
        probabilities: { explicit_linkage: 0.01, conditional_linkage: 0.02,
          capability_class_alignment: 0.03, adjacency: 0.91, insufficient_evidence: 0.03 } },
      alignment: { level: 'related_domain' as const, confidence: 0.8,
        probabilities: { no_overlap: 0.05, related_domain: 0.8, same_class: 0.1, directly_comparable: 0.05 } },
      provider: { name: 'jev-client-fit', model: 'jev-1.13.0', questionVersion: 'client_fit.v1' },
      latencyMs: 3,
    })) } as ClientFitProvider;
    const result = await applyMatchLabelControl({
      mode: 'enforce', reply: 'Direct match: Pursue secure sustainment [1].', citations, evidence,
      evaluate: createClientFitEvaluator({ provider, tenantId: 'tenant-1', deadlineAt: Date.now() + 8_000 }),
    });
    expect(result.derived[0]?.label).toBe('adjacency');
    expect(result.jevUsed).toBe(true);
    expect(provider.assess).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', claimCategory: 'client_fit' }),
      expect.objectContaining({ questions: expect.objectContaining({ client_fit: expect.any(Object),
        client_fit_alignment: expect.any(Object) }) }),
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
  });

  it('keeps deterministic behavior unchanged when client-fit is unavailable', async () => {
    const input = { mode: 'shadow' as const, reply: 'Direct match: Pursue secure sustainment [1].',
      citations, evidence };
    expect(await applyMatchLabelControl(input)).toEqual(await applyMatchLabelControl({ ...input }));
  });

  it('leaves a correctly evidenced direct match untouched', async () => {
    const client = { ...evidence[0]!, id: 'client-2', sourceId: 'client-2', sourceType: 'read_client_documents',
      evidenceClass: 'client_approved_context' as const, title: 'Client capability' };
    const reply = 'Direct match: Pursue secure sustainment [1] [2].';
    const result = await applyMatchLabelControl({ mode: 'enforce', reply,
      citations: [...citations, { ...citations[0]!, n: 2, id: 'client-2', tool: 'read_client_documents' }],
      evidence: [...evidence, client],
      evaluate: async () => ({ category: 'explicit_linkage', confidence: 0.9, jevUsed: true }),
    });
    expect(result.reply).toBe(`${reply} Eligibility has not been assessed; verify mandatory requirements before pursuing.`);
  });

  it('returns the original reply when evaluation fails', async () => {
    const reply = 'Direct match: Pursue secure sustainment [1].';
    const result = await applyMatchLabelControl({ mode: 'enforce', reply, citations, evidence,
      evaluate: async () => { throw new Error('deadline'); } });
    expect(result.reply).toBe(reply);
    expect(result.failureReason).toBe('Error');
  });
});
