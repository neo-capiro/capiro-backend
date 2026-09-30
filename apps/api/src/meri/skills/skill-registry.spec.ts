import { CLIO_SKILLS, matchSkill } from './skill-registry.js';
import { MERI_SKILL_REGISTRY } from '@capiro/shared/meri-skills';

// Golden values copied from the legacy inline maps in meri.service.ts
// (intentGuidance + templateForIntent). The migrated skills MUST stay
// byte-identical to these so flipping CLIO_SKILLS_ENABLED never changes model
// output — that is the P0-5 acceptance ("migrated skill == removed hardcoded").
const LEGACY_INTENT_GUIDANCE: Record<string, string> = {
  generate_draft:
    'Generate a professional government affairs email with proper tone and structure.',
  generate_briefing:
    'Create an actionable briefing with key points, risks, and recommendations. Use intelligence data when relevant.',
};
const LEGACY_TEMPLATES: Record<string, { heading: string; sections: string[] }> = {
  generate_briefing: {
    heading: 'Government Affairs Briefing',
    sections: ['Executive Summary', 'Signal Scan', 'Opportunities', 'Risks', 'Recommended Actions'],
  },
  generate_draft: {
    heading: 'Outreach Draft',
    sections: ['Subject Line', 'Opening', 'Core Message', 'Ask / CTA', 'Close'],
  },
};

describe('matchSkill', () => {
  it('activates the briefing skill for generate_briefing', () => {
    expect(matchSkill('generate_briefing')?.id).toBe('briefing');
  });
  it('activates the draft skill for generate_draft', () => {
    expect(matchSkill('generate_draft')?.id).toBe('draft');
  });
  it('returns null for un-migrated / unknown intents (legacy fallback handles them)', () => {
    expect(matchSkill('query_intelligence')).toBeNull();
    expect(matchSkill('general_question')).toBeNull();
    expect(matchSkill('')).toBeNull();
  });
});

describe('migrated skills are byte-identical to the legacy inline definitions', () => {
  const migrated = CLIO_SKILLS.filter((s) => s.triggers[0]! in LEGACY_INTENT_GUIDANCE);
  for (const skill of migrated) {
    const intent = skill.triggers[0]!;
    it(`${skill.id}: systemAddendum matches legacy intentGuidance[${intent}]`, () => {
      expect(skill.systemAddendum).toBe(LEGACY_INTENT_GUIDANCE[intent]);
    });
    it(`${skill.id}: template matches legacy templateForIntent('${intent}')`, () => {
      expect(skill.template).toEqual(LEGACY_TEMPLATES[intent]);
    });
  }
});

describe('all registered skills are well-formed', () => {
  for (const skill of CLIO_SKILLS) {
    it(`${skill.id}: has an id, trigger(s) and required tools`, () => {
      expect(skill.id).toBeTruthy();
      expect(skill.triggers.length).toBeGreaterThan(0);
      expect(skill.requiredTools.length).toBeGreaterThan(0);
    });
  }
});

describe('procedure slice preserves existing inventories', () => {
  it('keeps the six built-in procedural skills unchanged', () => {
    expect(CLIO_SKILLS.map((skill) => skill.id)).toEqual([
      'briefing',
      'draft',
      'bill_analysis',
      'hearing_prep',
      'coalition_letter',
      'amendment_tracker',
    ]);
  });

  it('keeps all 14 starter definitions including Commitments & Deliverables', () => {
    expect(MERI_SKILL_REGISTRY).toHaveLength(14);
    expect(MERI_SKILL_REGISTRY.find((skill) => skill.id === 'commitments_audit')).toMatchObject({
      label: 'Commitments & Deliverables',
      requiresClient: true,
      permittedScopes: ['general', 'client'],
      readOnly: true,
    });
  });
});

describe('lobbying skills library (P1-8)', () => {
  it('registers each new skill on its intent', () => {
    expect(matchSkill('analyze_bill')?.id).toBe('bill_analysis');
    expect(matchSkill('prep_hearing')?.id).toBe('hearing_prep');
    expect(matchSkill('draft_coalition_letter')?.id).toBe('coalition_letter');
    expect(matchSkill('track_amendment')?.id).toBe('amendment_tracker');
  });
  it('each new skill has a structured output template', () => {
    for (const id of ['bill_analysis', 'hearing_prep', 'coalition_letter', 'amendment_tracker']) {
      const skill = CLIO_SKILLS.find((s) => s.id === id)!;
      expect(skill.template?.sections.length).toBeGreaterThan(0);
    }
  });
});
