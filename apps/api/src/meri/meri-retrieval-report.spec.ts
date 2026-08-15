import { buildMeriRetrievalProductionReport } from './meri-retrieval-report.js';

describe('buildMeriRetrievalProductionReport', () => {
  test('aggregates coverage, recipe adherence, pagination debt, latency and token usage', () => {
    const report = buildMeriRetrievalProductionReport([
      {
        createdAt: '2026-08-15T10:00:00.000Z',
        metadata: {
          usage: { inputTokens: 1000, outputTokens: 200 },
          retrieval: {
            plan: {
              recipeTool: 'query_portfolio_changes',
              subjectScope: 'portfolio',
            },
            coverage: {
              complete: false,
              missingDomains: ['hearings'],
              partialDomains: ['tasks', 'mail'],
            },
            trace: {
              durationMs: 900,
              cumulativeToolMs: 1200,
              recipeFirst: true,
              paginationDebt: ['query_tasks'],
              outOfPlanModelTools: [],
            },
          },
        },
      },
      {
        createdAt: '2026-08-15T10:05:00.000Z',
        metadata: {
          usage: { inputTokens: 500, outputTokens: 100 },
          retrieval: {
            plan: {
              recipeTool: 'query_relationship_brief',
              subjectScope: 'external_entity',
            },
            coverage: {
              complete: true,
              missingDomains: [],
              partialDomains: [],
            },
            trace: {
              durationMs: 100,
              cumulativeToolMs: 80,
              recipeFirst: false,
              paginationDebt: [],
              outOfPlanModelTools: ['search_public_web'],
            },
          },
        },
      },
      {
        createdAt: '2026-08-15T10:10:00.000Z',
        metadata: {
          servedBy: 'meriv3',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    ]);

    expect(report).toEqual(
      expect.objectContaining({
        messagesScanned: 3,
        retrievalTurns: 2,
        coverageCompleteTurns: 1,
        coverageCompleteRate: 0.5,
        recipeFirstEligibleTurns: 2,
        recipeFirstTurns: 1,
        recipeFirstRate: 0.5,
        averageCumulativeToolMs: 640,
        tokens: { input: 1500, output: 300 },
      }),
    );
    expect(report.durationMs).toEqual({ p50: 100, p95: 900, max: 900 });
    expect(report.byRecipe).toEqual(
      expect.arrayContaining([
        {
          recipe: 'query_portfolio_changes',
          turns: 1,
          completeTurns: 0,
          completeRate: 0,
        },
        {
          recipe: 'query_relationship_brief',
          turns: 1,
          completeTurns: 1,
          completeRate: 1,
        },
      ]),
    );
    expect(report.bySubjectScope).toEqual(
      expect.arrayContaining([
        { subjectScope: 'portfolio', turns: 1 },
        { subjectScope: 'external_entity', turns: 1 },
      ]),
    );
    expect(report.missingDomains).toEqual([{ key: 'hearings', count: 1 }]);
    expect(report.partialDomains).toEqual([
      { key: 'mail', count: 1 },
      { key: 'tasks', count: 1 },
    ]);
    expect(report.paginationDebt).toEqual([{ key: 'query_tasks', count: 1 }]);
    expect(report.outOfPlanModelTools).toEqual([{ key: 'search_public_web', count: 1 }]);
  });

  test('returns null rates and latency when no retrieval metadata exists', () => {
    const report = buildMeriRetrievalProductionReport([
      { createdAt: new Date(), metadata: { servedBy: 'legacy' } },
    ]);

    expect(report.retrievalTurns).toBe(0);
    expect(report.coverageCompleteRate).toBeNull();
    expect(report.recipeFirstRate).toBeNull();
    expect(report.durationMs).toEqual({ p50: null, p95: null, max: null });
    expect(report.averageCumulativeToolMs).toBeNull();
    expect(report.byRecipe).toEqual([]);
  });

  test('does not inspect or surface message bodies, client names or entity targets', () => {
    const report = buildMeriRetrievalProductionReport([
      {
        createdAt: '2026-08-15T10:00:00.000Z',
        metadata: {
          retrieval: {
            plan: {
              recipeTool: 'research_external_company',
              subjectScope: 'external_entity',
              targetHint: 'Private Company Name',
            },
            coverage: { complete: false, missingDomains: [], partialDomains: [] },
            trace: {
              durationMs: 1,
              cumulativeToolMs: 1,
              recipeFirst: true,
              paginationDebt: [],
              outOfPlanModelTools: [],
            },
          },
        },
      },
    ]);

    expect(JSON.stringify(report)).not.toContain('Private Company Name');
  });
});
