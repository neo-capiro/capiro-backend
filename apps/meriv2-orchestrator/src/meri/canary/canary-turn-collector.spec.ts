import { CanaryTurnCollector, replyRequestsClarification } from './canary-turn-collector';

const identity = { conversationId: 'c', tenantId: 't', surface: 'chat' as const,
  modes: { evidenceAccuracy: 'off', claimAssessment: 'off', coverageRetrieval: 'shadow',
    passageSelection: 'enforce', autoCorrection: 'off', jevProvider: 'shadow', routing: 'cascade' } };

describe('CanaryTurnCollector', () => {
  it('assembles fakes without changing reply/frame ordering', () => {
    const times = [100, 220]; const collector = new CanaryTurnCollector(identity, () => times.shift() ?? 220);
    collector.noteCoverage({ gaps: 2, followUps: 1, residual: 1, latencyMs: 10 });
    collector.notePassageSelection({ candidates: 3, kept: 2, dropped: 1, requiredCandidates: 1,
      requiredRetained: 1, contradictoryRetained: 1, fallback: false, latencyMs: 20, tokens: 5, costUsd: .2 });
    collector.noteRepair({ attempted: 1, corrected: 1, qualified: 0, omitted: 0, documentRequested: 0,
      budgetExhausted: 0, assessmentMs: 30, repairMs: 40, tokens: 6, costUsd: .3 });
    const order: string[] = [];
    const emit = (_frame: { type: string; text: string }) => { order.push('text'); };
    emit({ type: 'text', text: 'unchanged' });
    const logged = collector.build({ outcome: 'released', clarificationRequested: false });
    order.push('canary');
    expect(order).toEqual(['text', 'canary']);
    expect(logged).toMatchObject({ coverage: { followUps: 1 }, passageSelection: { requiredRetained: 1 },
      repair: { corrected: 1 }, latencyMs: { total: 120 }, estimatedCostUsd: .5 });
  });

  it('detects explicit deterministic questions and document requests', () => {
    expect(replyRequestsClarification('Which client did you mean?', 0)).toBe(true);
    expect(replyRequestsClarification('The result is complete.', 0)).toBe(false);
    expect(replyRequestsClarification('Attach the named transcript.', 1)).toBe(true);
  });
});
