import type { MeriContext } from '@capiro/meriv2-core';
import { classifyMeriRetrievalIntent } from './meri-retrieval-intent.js';
import { buildMeriRetrievalPlan } from './meri-retrieval-plan.js';

const ctx = {
  clientRoster: [
    { name: 'Client A', status: 'active' },
    { name: 'Client B', status: 'active' },
  ],
} as unknown as MeriContext;

describe('Meri retrieval production eval corpus', () => {
  test.each([
    {
      prompt: 'What changed across my clients this week?',
      selectedClientId: 'client-a',
      subjectScope: 'portfolio',
      queryClass: 'change_detection',
      recipe: 'query_portfolio_changes',
      complete: true,
    },
    {
      prompt: 'Look in my inbox and tell me everything I should know about Victory Six',
      selectedClientId: 'client-a',
      subjectScope: 'external_entity',
      queryClass: 'relationship_history',
      recipe: 'query_relationship_brief',
      complete: true,
    },
    {
      prompt: 'Give me a summary of my emails from Powers Interactive',
      selectedClientId: 'client-a',
      subjectScope: 'external_entity',
      queryClass: 'relationship_history',
      recipe: 'query_relationship_brief',
      complete: true,
    },
    {
      prompt:
        'Give me a comprehensive strategy on kindeticindustries.inc. Tell me what Program Elements, grants, or government contracts they should pursue.',
      selectedClientId: 'client-a',
      subjectScope: 'external_entity',
      queryClass: 'federal_market_analysis',
      recipe: 'research_external_company',
      complete: true,
    },
    {
      prompt: 'Compare my client with Shield AI',
      selectedClientId: 'client-a',
      subjectScope: 'external_entity',
      queryClass: 'comparison',
      recipe: 'research_external_company',
      complete: false,
    },
    {
      prompt: 'Nothing happened with this client this week, right?',
      selectedClientId: 'client-a',
      subjectScope: 'client',
      queryClass: 'change_detection',
      recipe: 'query_client_changes',
      complete: true,
    },
  ])(
    '$prompt',
    ({ prompt, selectedClientId, subjectScope, queryClass, recipe, complete }) => {
      const intent = classifyMeriRetrievalIntent(prompt, selectedClientId);
      const plan = buildMeriRetrievalPlan(prompt, intent, ctx);

      expect(intent.subjectScope).toBe(subjectScope);
      expect(intent.queryClass).toBe(queryClass);
      expect(plan.recipeTool).toBe(recipe);
      expect(plan.requireCompleteCoverage).toBe(complete);
      expect(plan.requiredDomains.length).toBeGreaterThan(0);
    },
  );

  test('carries the researched company into the terse Search across clients follow-up', () => {
    const intent = classifyMeriRetrievalIntent('Search across clients', 'client-a');
    const plan = buildMeriRetrievalPlan(
      'Search across clients',
      intent,
      ctx,
      'Kinetic Industries',
    );

    expect(plan.recipeTool).toBe('query_portfolio_overlap');
    expect(plan.targetHint).toBe('Kinetic Industries');
    expect(plan.activeClients).toHaveLength(2);
  });

  test('keeps a simple named organization independent from stale selected-client context', () => {
    const intent = classifyMeriRetrievalIntent('Tell me about Anduril', 'client-a');

    expect(intent.subjectScope).toBe('external_entity');
    expect(intent.includeFocusedClientContext).toBe(false);
    expect(intent.targetHint).toBe('Anduril');
  });
});
