import type { MeriRetrievalPlan } from './meri-retrieval-plan.js';
import {
  MERI_EXTERNAL_COMPANY_RESEARCH_SKILL_VERSION,
  meriExternalCompanyResearchSkillPrompt,
} from './meri-external-company-research-skill.js';

function plan(recipeTool: MeriRetrievalPlan['recipeTool']): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'federal_market_analysis',
    subjectScope: 'external_entity',
    targetHint: 'kindeticindustries.inc',
    recipeTool,
    requireCompleteCoverage: false,
    requiredDomains: ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    optionalDomains: ['grants', 'budget', 'internal_research'],
    recommendedTools: recipeTool ? [recipeTool] : [],
    timeWindow: null,
    activeClients: [],
    reasons: [],
  };
}

describe('Meri external company research skill', () => {
  test('requires full reporting for resolved or provisional identities', () => {
    const prompt = meriExternalCompanyResearchSkillPrompt(
      plan('research_external_company'),
    );

    expect(MERI_EXTERNAL_COMPANY_RESEARCH_SKILL_VERSION).toBe(1);
    expect(prompt).toMatch(/Call research_external_company first/i);
    expect(prompt).toMatch(/failed literal-name resolution.*beginning of discovery/i);
    expect(prompt).toMatch(/provisional.*continue and produce the full report/i);
    expect(prompt).toMatch(/Do not hand the research task back to the user/i);
    expect(prompt).toMatch(/Program Elements and budget lines/i);
    expect(prompt).toMatch(/contracts and SAM opportunities/i);
    expect(prompt).toMatch(/30\/60\/90-day action plan/i);
    expect(prompt).toMatch(/Retrieval coverage/i);
  });

  test('does not inject the company skill into unrelated retrieval plans', () => {
    expect(meriExternalCompanyResearchSkillPrompt(plan('query_relationship_brief'))).toBe('');
    expect(meriExternalCompanyResearchSkillPrompt(plan(null))).toBe('');
  });
});
