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

  test('routes comprehensive federal-market work to the Research Director recipe', () => {
    const result = plan(
      'Give me a comprehensive strategy on kindeticindustries.inc and tell me what Program Elements, grants, and government contracts it should pursue.',
    );

    expect(result.recipeTool).toBe('research_federal_market_strategy');
    expect(result.targetHint).toBe('kindeticindustries.inc');
    expect(result.requiredDomains).toEqual(
      expect.arrayContaining([
        'identity',
        'public_web',
        'registries',
        'awards',
        'opportunities',
        'grants',
        'budget',
        'intelligence',
        'directory',
      ]),
    );
    expect(result.recommendedTools).toEqual(
      expect.arrayContaining([
        'research_federal_market_strategy',
        'get_pe_report_language',
        'get_pe_contractors',
        'get_pe_bills',
        'search_acquisition_personnel',
      ]),
    );
    expect(result.reasons).toContain('research-director-required');
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

  test('renders the mandatory Research Director contract', () => {
    const prompt = meriRetrievalPlanPrompt(
      plan('Give me a comprehensive federal growth strategy for Kinetic Industries.'),
    );
    expect(prompt).toContain('Call research_federal_market_strategy FIRST.');
    expect(prompt).toContain('Do not substitute research_external_company');
    expect(prompt).toContain('congressional research');
    expect(prompt).toContain('senior-reviewer gap check');
  });
});
