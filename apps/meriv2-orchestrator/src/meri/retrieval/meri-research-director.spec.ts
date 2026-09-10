import {
  buildMeriResearchDirectorPlan,
  elevateMeriResearchReasoningMode,
  isComprehensiveFederalMarketResearch,
  meriResearchCriticInstructions,
  meriResearchDirectorPrompt,
  meriResearchSynthesisInstructions,
} from './meri-research-director.js';

describe('Meri research director', () => {
  test('recognizes comprehensive federal-market strategy requests', () => {
    expect(
      isComprehensiveFederalMarketResearch(
        'Give me a comprehensive strategy on kindeticindustries.inc. Tell me what Program Elements, grants, or government contracts they should pursue.',
      ),
    ).toBe(true);
    expect(
      isComprehensiveFederalMarketResearch(
        'What should Anduril pursue?',
        'federal_market_analysis',
      ),
    ).toBe(true);
    expect(isComprehensiveFederalMarketResearch('What time is the meeting?')).toBe(false);
  });

  test('elevates comprehensive work to Deep while preserving Max', () => {
    expect(elevateMeriResearchReasoningMode('fast', true)).toBe('deep');
    expect(elevateMeriResearchReasoningMode('standard', true)).toBe('deep');
    expect(elevateMeriResearchReasoningMode('deep', true)).toBe('deep');
    expect(elevateMeriResearchReasoningMode('max', true)).toBe('max');
    expect(elevateMeriResearchReasoningMode('fast', false)).toBe('fast');
  });

  test('builds every mandatory research wave and artifact-quality section', () => {
    const plan = buildMeriResearchDirectorPlan(
      'Comprehensive federal growth strategy for a domestic fiber communications subsystem for tactical unmanned systems.',
      'Kinetic Industries',
    );

    expect(plan.target).toBe('Kinetic Industries');
    expect(plan.waves.map((wave) => wave.id)).toEqual([
      'identity',
      'capability',
      'mission',
      'acquisition',
      'congressional',
      'scale',
      'verification',
    ]);
    expect(plan.requiredDomains).toEqual(
      expect.arrayContaining([
        'capability_model',
        'mission_map',
        'budget_programs',
        'contracts_otas',
        'congressional',
        'partners',
        'industrial_base',
        'compliance',
        'execution',
      ]),
    );
    expect(plan.hypotheses.join(' ')).toMatch(/launched effects/i);
    expect(plan.hypotheses.join(' ')).toMatch(/assured command-and-control/i);
    expect(plan.outputSections).toHaveLength(15);
  });

  test('emits mandatory director, critic and synthesis contracts', () => {
    const plan = buildMeriResearchDirectorPlan('comprehensive capture strategy', 'Example Co');
    expect(meriResearchDirectorPrompt(plan)).toMatch(
      /dedicated federal-market strategy recipe first/i,
    );
    expect(meriResearchDirectorPrompt(plan)).toMatch(/do not synthesize early/i);
    expect(meriResearchCriticInstructions(plan)).toMatch(/senior federal capture executive/i);
    expect(meriResearchCriticInstructions(plan)).toMatch(/missingSections/);
    expect(meriResearchSynthesisInstructions(plan)).toMatch(/Direct match/);
    expect(meriResearchSynthesisInstructions(plan)).toMatch(/detailed client-ready report/i);
  });
});
