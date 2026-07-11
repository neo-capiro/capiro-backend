// C7 relevance gate (whole-plan review): the market-wide surging-LDA block is
// injected only when the client is a matched federal contractor; the
// client-specific contracting block is always included when there's a match.

import { describe, expect, test } from '@jest/globals';
import { EngagementAiService } from './engagement-ai.service.js';

function buildFederalContext(matched: boolean): Promise<string> {
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  const patch = svc as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {} };
  patch.lobbyIntel = {
    getAiContext: async () => ({
      latestQuarter: '2025Q4',
      surgingIssues: [{ code: 'DEF', name: 'Defense', surgePct: 42 }],
      trendingTopics: [{ word: 'hypersonics' }],
    }),
  };
  patch.federalSpending = {
    getAiContext: async () => ({
      matchedContractor: matched
        ? {
            name: 'Aperture',
            topAgencies: [],
            totalContracts: 5_000_000,
            rankByContracts: null,
            category: null,
          }
        : null,
      topAgencyTotals: [{ name: 'DoD', budget: 800_000_000_000 }],
    }),
  };
  return (
    svc as unknown as { buildFederalContextBlock(n: string | null): Promise<string> }
  ).buildFederalContextBlock('Aperture Defense Systems');
}

describe('buildFederalContextBlock — C7 relevance gate', () => {
  test('a matched federal contractor gets the contracting + market-wide block', async () => {
    const out = await buildFederalContext(true);
    expect(out).toContain('Federal contracting context');
    expect(out).toContain('Surging LDA issues');
  });

  test('a NON-contractor client gets no market-wide LDA noise', async () => {
    const out = await buildFederalContext(false);
    expect(out).not.toContain('Surging LDA issues');
    expect(out).not.toContain('Top federal agencies by budget');
    // Nothing client-specific matched either → empty block (not force-injected).
    expect(out).toBe('');
  });
});
