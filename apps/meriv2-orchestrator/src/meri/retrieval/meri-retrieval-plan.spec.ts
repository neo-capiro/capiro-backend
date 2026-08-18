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

  test('routes the exact Overland prompt to a bounded company profile', () => {
    const result = plan('what does overland ai do');

    expect(result).toEqual(
      expect.objectContaining({
        queryClass: 'lookup',
        subjectScope: 'external_entity',
        targetHint: 'overland ai',
        recipeTool: 'research_external_company',
        requireCompleteCoverage: false,
        requiredDomains: ['public_web'],
      }),
    );
    expect(result.reasons).toContain('quick-company-profile');
    expect(result.recommendedTools).toEqual(
      expect.arrayContaining([
        'research_external_company',
        'lookup_client_registry',
        'search_research_sources',
        'search_public_web',
        'scrape_web_page',
      ]),
    );
    for (const forbidden of [
      'research_federal_market_strategy',
      'resolve_entity',
      'search_lda_filings',
      'search_sec_filings',
      'search_federal_awards',
      'search_sam_opportunities',
      'search_federal_grants',
      'search_program_elements',
      'get_pe_budget_timeline',
      'get_pe_report_language',
    ]) {
      expect(result.recommendedTools).not.toContain(forbidden);
    }
  });

  test('routes the exact C2 prompt to mail-only required coverage', () => {
    const result = plan('tell me my email history with c2 strategies');

    expect(result).toEqual(
      expect.objectContaining({
        queryClass: 'relationship_history',
        subjectScope: 'external_entity',
        targetHint: 'c2 strategies',
        recipeTool: 'query_relationship_brief',
        requireCompleteCoverage: true,
        requiredDomains: ['mail'],
      }),
    );
    expect(result.reasons).toContain('mail-history-focus');
    expect(result.optionalDomains).toEqual(
      expect.arrayContaining(['contacts', 'memory', 'internal_research']),
    );
    expect(result.recommendedTools).toEqual(
      expect.arrayContaining([
        'query_relationship_brief',
        'search_emails',
        'find_contacts',
        'search_memory',
        'lookup_client_registry',
      ]),
    );
    for (const forbidden of [
      'research_external_company',
      'research_federal_market_strategy',
      'resolve_entity',
      'search_public_web',
      'search_lda_filings',
      'search_sec_filings',
      'search_federal_awards',
      'search_federal_grants',
      'search_program_elements',
    ]) {
      expect(result.recommendedTools).not.toContain(forbidden);
    }
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

  test('renders the bounded quick-profile contract', () => {
    const prompt = meriRetrievalPlanPrompt(plan('what does overland ai do'));

    expect(prompt).toContain('Call research_external_company FIRST.');
    expect(prompt).toContain('bounded company-description request');
    expect(prompt).toContain('Do not search LDA, SEC, awards, SAM, grants, Program Elements');
  });

  test('renders the mailbox-history contract', () => {
    const prompt = meriRetrievalPlanPrompt(
      plan('tell me my email history with c2 strategies'),
    );

    expect(prompt).toContain('Call query_relationship_brief FIRST.');
    expect(prompt).toContain('mailbox-history request');
    expect(prompt).toContain('Mail is the required evidence lane');
    expect(prompt).toContain('Do not search public web, LDA, SEC, awards');
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
