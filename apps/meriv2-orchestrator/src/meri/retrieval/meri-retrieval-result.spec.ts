import { compactMeriRetrievalRecipeResult } from './meri-retrieval-result.js';

describe('compactMeriRetrievalRecipeResult', () => {
  test('places coverage before evidence and caps large result arrays', () => {
    const compacted = compactMeriRetrievalRecipeResult({
      tool: 'query_portfolio_changes',
      coverage: { complete: false },
      results: Array.from({ length: 80 }, (_, index) => ({ id: `result-${index}` })),
      carryoverAttention: Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}` })),
    }) as Record<string, unknown>;

    expect(Object.keys(compacted)[0]).toBe('coverage');
    expect(compacted.results).toHaveLength(30);
    expect(compacted.carryoverAttention).toHaveLength(10);
  });

  test('also bounds nested company research in portfolio overlap', () => {
    const compacted = compactMeriRetrievalRecipeResult({
      coverage: { complete: true },
      companyResearch: {
        coverage: { complete: false },
        results: Array.from({ length: 50 }, (_, index) => ({ id: index })),
      },
      results: [],
    }) as {
      companyResearch: { coverage: unknown; results: unknown[] };
    };

    expect(Object.keys(compacted.companyResearch)[0]).toBe('coverage');
    expect(compacted.companyResearch.results).toHaveLength(20);
  });
});
