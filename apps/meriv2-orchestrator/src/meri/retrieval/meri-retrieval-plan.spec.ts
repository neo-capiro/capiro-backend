import type { MeriContext } from '@capiro/meriv2-core';
import { classifyMeriRetrievalIntent } from './meri-retrieval-intent.js';
import { buildMeriRetrievalPlan, meriRetrievalPlanPrompt } from './meri-retrieval-plan.js';

const context = {
  clientRoster: [
    { name: 'Aperture Defense Systems', status: 'active' },
    { name: 'Legistorm', status: 'active' },
    { name: 'Former Client', status: 'inactive' },
  ],
} as unknown as MeriContext;

function plan(request: string, priorTargetHint?: string | null) {
  return buildMeriRetrievalPlan(
    request,
    classifyMeriRetrievalIntent(request, 'selected-client'),
    context,
    priorTargetHint,
  );
}

describe('buildMeriRetrievalPlan', () => {
  test('routes weekly portfolio change requests to deterministic fan-out', () => {
    const result = plan('What changed across my clients this week?');

    expect(result.recipeTool).toBe('query_portfolio_changes');
    expect(result.timeWindow).toEqual({ expression: 'this week', withinDays: 7 });
    expect(result.activeClients).toEqual([
      { name: 'Aperture Defense Systems', status: 'active', id: 'Aperture Defense Systems' },
      { name: 'Legistorm', status: 'active', id: 'Legistorm' },
    ]);
    expect(result.requiredDomains).toEqual(
      expect.arrayContaining(['clients', 'mail', 'meetings', 'tasks', 'legislation']),
    );
  });

  test('routes entity relationship briefs to the relationship recipe', () => {
    const result = plan('Tell me everything I should know about Victory Six');

    expect(result.recipeTool).toBe('query_relationship_brief');
    expect(result.targetHint).toBe('Victory Six');
    expect(result.requireCompleteCoverage).toBe(true);
  });

  test('routes misspelled domain-style federal-market work to external research', () => {
    const result = plan(
      'Give me a comprehensive strategy on kindeticindustries.inc and tell me what Program Elements and contracts it should pursue.',
    );

    expect(result.recipeTool).toBe('research_external_company');
    expect(result.targetHint).toBe('kindeticindustries.inc');
    expect(result.requiredDomains).toEqual(
      expect.arrayContaining(['identity', 'public_web', 'registries', 'awards', 'opportunities']),
    );
  });

  test('routes the explicit Search across clients follow-up to portfolio overlap', () => {
    const result = plan('Search across clients', 'Kinetic Industries Inc.');

    expect(result.recipeTool).toBe('query_portfolio_overlap');
    expect(result.targetHint).toBe('Kinetic Industries Inc.');
    expect(result.reasons).toContain('target-from-conversation-history');
  });

  test('does not assign a high-level recipe to an ordinary client lookup', () => {
    const result = plan("What are this client's current priorities?");

    expect(result.recipeTool).toBeNull();
    expect(result.requiredDomains).toEqual([]);
  });

  test('renders the recipe, active-client count, and negative-claim guard', () => {
    const prompt = meriRetrievalPlanPrompt(plan('What changed across my clients this week?'));

    expect(prompt).toContain('Call query_portfolio_changes FIRST.');
    expect(prompt).toContain('Authorized active client count: 2.');
    expect(prompt).toContain('Aperture Defense Systems (Aperture Defense Systems)');
    expect(prompt).toContain('Do not turn zero matches into a claim of absence');
  });
});
