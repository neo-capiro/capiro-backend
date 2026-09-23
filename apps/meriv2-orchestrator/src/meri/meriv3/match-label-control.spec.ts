import type { AssuredEvidence } from '@capiro/meriv2-core';
import { applyMatchLabelControl, matchLabelEvent } from './match-label-control.js';

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
      downgraded: 1, jevUsed: false, latencyMs: 4, registryVersion: 'jev-task-registry.v2' });
    expect(JSON.stringify(matchLabelEvent(result, 4))).not.toContain('secure sustainment');
  });

  it('downgrades an overstated direct match but preserves the recommendation', async () => {
    const result = await applyMatchLabelControl({
      mode: 'enforce', reply: 'Direct match: Pursue secure sustainment [1].', citations, evidence,
      evaluate: async () => ({ category: 'conditional_linkage', confidence: 0.9, jevUsed: true }),
    });
    expect(result.reply).toContain('Conditional niche: Pursue secure sustainment [1].');
    expect(result.reply).toContain('conditional relationship');
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
    expect(result.reply).toBe(reply);
  });

  it('returns the original reply when evaluation fails', async () => {
    const reply = 'Direct match: Pursue secure sustainment [1].';
    const result = await applyMatchLabelControl({ mode: 'enforce', reply, citations, evidence,
      evaluate: async () => { throw new Error('deadline'); } });
    expect(result.reply).toBe(reply);
    expect(result.failureReason).toBe('Error');
  });
});
