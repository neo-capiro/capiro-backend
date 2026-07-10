import { describe, expect, it } from '@jest/globals';
import { AI_PRICING, computeAiCostUsd } from '@capiro/shared';

describe('computeAiCostUsd (lifted into @capiro/shared, Phase 1 M5.0)', () => {
  it('computes cost from input+output tokens for a known model', () => {
    // gpt-4.1: $2.00 / 1M input, $8.00 / 1M output
    const cost = computeAiCostUsd('gpt-4.1', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(10.0, 5);
  });

  it('scales linearly with token counts', () => {
    // gpt-4.1-mini: $0.40 / 1M input, $1.60 / 1M output
    const cost = computeAiCostUsd('gpt-4.1-mini', 500_000, 250_000);
    expect(cost).toBeCloseTo(0.2 + 0.4, 5);
  });

  it('returns 0 cost but does not throw for an unknown model', () => {
    expect(computeAiCostUsd('made-up-model', 1000, 1000)).toBe(0);
  });

  it('returns 0 for zero tokens', () => {
    expect(computeAiCostUsd('gpt-4.1', 0, 0)).toBe(0);
  });

  it('exposes pricing for the models we actually use', () => {
    for (const m of ['gpt-4.1', 'gpt-4.1-mini', 'claude-haiku-4-5-20251001']) {
      expect(AI_PRICING[m]).toBeDefined();
    }
  });

  it('matches dated-snapshot model ids to their base alias pricing', () => {
    // Anthropic full IDs carry a -YYYYMMDD suffix; pricing is keyed by alias.
    expect(computeAiCostUsd('claude-haiku-4-5-20251001', 1_000_000, 0)).toBeCloseTo(1.0, 5);
  });
});
