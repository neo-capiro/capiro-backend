import type { MeriContext } from '@capiro/meriv2-core';
import { MERI_SKILL_REGISTRY, hydrateMeriStarterPrompt } from '@capiro/shared/meri-skills';
import { classifyMeriRetrievalIntent } from './meri-retrieval-intent.js';
import { buildMeriRetrievalPlan } from './meri-retrieval-plan.js';

const context = {
  clientRoster: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'TitanForge',
      status: 'active',
    },
  ],
} as unknown as MeriContext;

function skill(id: string) {
  const definition = MERI_SKILL_REGISTRY.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing Meri skill ${id}`);
  return definition;
}

function planFor(prompt: string, selectedClientId?: string) {
  const intent = classifyMeriRetrievalIntent(prompt, selectedClientId);
  return buildMeriRetrievalPlan(prompt, intent, context);
}

describe('Meri Quick Action routing contract', () => {
  test('Research a Company routes to the Research Director', () => {
    const definition = skill('research_company');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[company name or domain]',
      'kineticindustries.inc',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Relationship Brief routes to deterministic relationship fan-out', () => {
    const definition = skill('relationship_brief');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[person or organization]',
      'Victory Six',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Client Changes stays pinned to the selected workspace client', () => {
    const definition = skill('client_changes');
    const prompt = hydrateMeriStarterPrompt(definition, { clientName: 'TitanForge' });
    const plan = planFor(prompt, '11111111-1111-4111-8111-111111111111');

    expect(plan.subjectScope).toBe('client');
    expect(plan.recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Portfolio Changes routes to the full authorized roster scan', () => {
    const definition = skill('portfolio_changes');
    const prompt = hydrateMeriStarterPrompt(definition);

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Portfolio Overlap routes to evidence-backed portfolio comparison', () => {
    const definition = skill('portfolio_overlap');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[external company or domain]',
      'Shield AI',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Mail History routes to the relationship fan-out with the mail lane', () => {
    const definition = skill('mail_history');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[person or organization]',
      'Victory Six',
    );
    const plan = planFor(prompt);

    expect(plan.recipeTool).toBe(definition.canonicalRecipe);
    expect(prompt).toMatch(/mailbox history/);
  });

  test('Meeting Prep routes to the relationship fan-out recipe', () => {
    const definition = skill('meeting_prep');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[client, person, or issue]',
      'HCA',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Commitments audit stays pinned to the selected workspace client', () => {
    const definition = skill('commitments_audit');
    const prompt = hydrateMeriStarterPrompt(definition, { clientName: 'TitanForge' });
    const plan = planFor(prompt, '11111111-1111-4111-8111-111111111111');

    expect(plan.subjectScope).toBe('client');
    expect(plan.recipeTool).toBe(definition.canonicalRecipe);
  });

  test('Funding Opportunity Match routes to the four-tool opportunity fan-out', () => {
    const definition = skill('funding_opportunity_match');
    const prompt = hydrateMeriStarterPrompt(definition, { clientName: 'TitanForge' });
    const plan = planFor(prompt, '11111111-1111-4111-8111-111111111111');

    expect(plan.recipeTool).toBe(definition.canonicalRecipe);
    expect(plan.recipeTool).toBe('query_funding_opportunity_match');
    expect(plan.recommendedTools).toEqual(
      expect.arrayContaining([
        'search_funding_opportunities',
        'get_opportunity_client_context',
        'get_opportunity_government_landscape',
        'explain_opportunity_match',
      ]),
    );
  });

  test('PE Deep Dive routes to the five-reader Program Element fan-out', () => {
    const definition = skill('pe_deep_dive');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[PE number or name]',
      'PE 0604852N',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
    expect(planFor(prompt).recipeTool).toBe('query_pe_deep_dive');
  });

  test('Bill Watch routes to the tracked + federal + state bill fan-out', () => {
    const definition = skill('bill_watch');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[client name]',
      'TitanForge Industries',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
    expect(planFor(prompt).recipeTool).toBe('query_bill_watch');
  });

  test('Hearing Watch routes to the committee-hearings fan-out', () => {
    const definition = skill('hearing_watch');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[client name]',
      'TitanForge Industries',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
    expect(planFor(prompt).recipeTool).toBe('query_hearing_watch');
  });

  test('Representation Lookup routes to the roster + mapping fan-out', () => {
    const definition = skill('representation_lookup');
    const prompt = hydrateMeriStarterPrompt(definition)
      .replace('[state or district]', 'Virginia')
      .replace('[client name]', 'TitanForge Industries');

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
    expect(planFor(prompt).recipeTool).toBe('query_representation_lookup');
  });

  test('Regulatory Docket Brief routes to the federal + state rulemaking fan-out', () => {
    const definition = skill('regulatory_docket_brief');
    const prompt = hydrateMeriStarterPrompt(definition).replace(
      '[rule or docket keyword]',
      'PFAS discharge limits',
    );

    expect(planFor(prompt).recipeTool).toBe(definition.canonicalRecipe);
    expect(planFor(prompt).recipeTool).toBe('query_regulatory_docket_brief');
  });
});
