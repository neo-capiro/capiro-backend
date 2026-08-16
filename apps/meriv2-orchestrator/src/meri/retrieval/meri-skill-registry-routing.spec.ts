import type { MeriContext } from '@capiro/meriv2-core';
import {
  MERI_SKILL_REGISTRY,
  hydrateMeriStarterPrompt,
} from '@capiro/shared/meri-skills';
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
});
