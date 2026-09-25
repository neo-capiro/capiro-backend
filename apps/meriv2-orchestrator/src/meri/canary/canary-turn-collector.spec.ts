import { CanaryTurnCollector, replyRequestsClarification } from './canary-turn-collector';

const identity = { conversationId: 'c', tenantId: 't', surface: 'chat' as const,
  modes: { evidenceAccuracy: 'off', claimAssessment: 'off', coverageRetrieval: 'shadow',
    passageSelection: 'enforce', autoCorrection: 'off', jevProvider: 'shadow', routing: 'cascade' } };

function collectorAt(times: number[]): CanaryTurnCollector {
  const last = times[times.length - 1] ?? 0;
  return new CanaryTurnCollector(identity, () => times.shift() ?? last);
}

// The text-frame-before-canary-event ordering is asserted against the real
// turn loop in meriv3-assistant.service.spec.ts ('emits the text frame before
// the canary event ...'); this file covers the collector's own measurements.
describe('CanaryTurnCollector', () => {
  it('measures time-to-text at the text frame and the total at build', () => {
    // started 100, text frame 150, build 220
    const collector = collectorAt([100, 150, 220]);
    collector.noteCoverage({ gaps: 2, followUps: 1, residual: 1, latencyMs: 10 });
    collector.notePassageSelection({ candidates: 3, kept: 2, dropped: 1, requiredCandidates: 1,
      requiredRetained: 1, contradictoryRetained: 1, fallback: false,
      safetyIntervention: { evaluated: true, intervened: true, reasons: ['required_candidate_restored'] },
      latencyMs: 20, tokens: 5, costUsd: .2 });
    collector.noteRepair({ attempted: 1, corrected: 1, qualified: 0, omitted: 0, documentRequested: 0,
      budgetExhausted: 0, assessmentMs: 30, repairMs: 40, tokens: 6, costUsd: .3 });
    collector.noteTextEmitted();
    const logged = collector.build({ outcome: 'released', clarificationRequested: false });
    expect(logged.latencyMs).toEqual({
      timeToText: 50, assessment: 30, passageSelection: 20, coverageFollowUp: 10, repair: 40, total: 120,
    });
    expect(logged).toMatchObject({ event: 'meri.canary.turn', surface: 'chat', coverage: { followUps: 1 },
      passageSelection: { requiredRetained: 1,
        safetyIntervention: { evaluated: true, intervened: true, reasons: ['required_candidate_restored'] } },
      repair: { corrected: 1 }, tokens: { jev: 5, repair: 6 },
      cost: { retrievalToolCalls: 1, retrievalLatencyMs: 10, coverageFollowUpTokens: 0,
        jevCalls: 1, legacyCalls: 0, repairLoops: 1 },
      registryVersion: 'jev-task-registry.v5',
      jevTasks: {
        passage_relevance: { questionVersion: 'passage_selection.v1', modelVersion: 'jev-1.13.0' },
      }, estimatedCostUsd: .5 });
  });

  it('keeps the first text-frame measurement if the frame is noted again', () => {
    const collector = collectorAt([100, 150, 220]);
    collector.noteTextEmitted();
    collector.noteTextEmitted();
    expect(collector.build({ outcome: 'released', clarificationRequested: false }).latencyMs)
      .toMatchObject({ timeToText: 50, total: 120 });
  });

  it('reports the whole duration as time-to-text when no text frame was emitted', () => {
    const collector = collectorAt([100, 220]);
    expect(collector.build({ outcome: 'aborted', clarificationRequested: false }).latencyMs)
      .toMatchObject({ timeToText: 120, total: 120 });
  });

  it('records the research surface for a Deep Research turn', () => {
    const collector = new CanaryTurnCollector({ ...identity, surface: 'research' }, () => 0);
    expect(collector.build({ outcome: 'released', clarificationRequested: false }).surface).toBe('research');
  });

  it('detects explicit deterministic questions and document requests', () => {
    expect(replyRequestsClarification('Which client did you mean?', 0)).toBe(true);
    expect(replyRequestsClarification('The result is complete.', 0)).toBe(false);
    expect(replyRequestsClarification('Attach the named transcript.', 1)).toBe(true);
  });
});
