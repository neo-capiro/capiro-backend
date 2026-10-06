import { describe, expect, it } from '@jest/globals';
import {
  RESEARCH_PLAN_LIMITS,
  ResearchPlanValidationError,
  buildResearchPlanRepairPrompt,
  buildResearchPlanSystemPrompt,
  researchPlanStringProjection,
  validateResearchPlan,
  type ResearchPlanAdmissionContext,
} from './meri-research-plan.js';

const context: ResearchPlanAdmissionContext = {
  scope: {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    actorId: 'user-1',
    clientId: 'client-1',
    conversationId: 'conversation-1',
  },
  capabilities: [
    { name: 'search_memory', sideEffecting: false },
    { name: 'search_public_web', sideEffecting: false },
    { name: 'send_email', sideEffecting: true },
  ],
};

function validPlan() {
  return {
    version: 1,
    title: 'Bounded client research',
    scope: { ...context.scope },
    budget: { toolCalls: 3, tokens: 7_000 },
    steps: [
      {
        id: 'verify-client-record',
        objective: 'Verify the current authorized client record.',
        dependsOn: [],
        requiredEvidenceDomains: ['client_context'],
        allowedCapabilities: ['search_memory'],
        effect: 'read',
        completionCondition: 'The current client constraint is supported or identified as unavailable.',
        budget: { toolCalls: 1, tokens: 2_000 },
      },
      {
        id: 'check-public-status',
        objective: 'Check the current public status against primary sources.',
        dependsOn: ['verify-client-record'],
        requiredEvidenceDomains: ['public_web'],
        allowedCapabilities: ['search_public_web'],
        effect: 'read',
        completionCondition: 'The current status and source date are recorded.',
        budget: { toolCalls: 2, tokens: 5_000 },
      },
    ],
    clarifyingQuestions: [] as string[],
  };
}

function issuesFor(plan: unknown): string[] {
  try {
    validateResearchPlan(plan, context);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ResearchPlanValidationError);
    return (error as ResearchPlanValidationError).issues;
  }
}

describe('typed research plan admission', () => {
  it('accepts the exact versioned contract and projects the compatible UI string plan', () => {
    const admitted = validateResearchPlan(JSON.stringify(validPlan()), context);
    expect(admitted.version).toBe(1);
    expect(researchPlanStringProjection(admitted)).toEqual([
      'Verify the current authorized client record.',
      'Check the current public status against primary sources.',
    ]);
  });

  it('is strict JSON and never treats tolerant string fallback as certification', () => {
    expect(issuesFor(`\`\`\`json\n${JSON.stringify(validPlan())}\n\`\`\``)).toContain(
      'plan_must_be_strict_json',
    );
    expect(issuesFor('not json')).toContain('plan_must_be_strict_json');
  });

  it('rejects duplicate object members at the root and in nested objects and arrays', () => {
    const serialized = JSON.stringify(validPlan());
    expect(
      issuesFor(serialized.replace('"version":1', '"version":99,"version":1')),
    ).toContain('duplicate_object_key:"version"');
    expect(
      issuesFor(
        serialized.replace(
          '"budget":{"toolCalls":3',
          '"budget":{"toolCalls":99,"toolC\\u0061lls":3',
        ),
      ),
    ).toContain('duplicate_object_key:"toolCalls"');
    expect(
      issuesFor(
        serialized.replace(
          '"id":"verify-client-record"',
          '"id":"shadowed","\\u0069d":"verify-client-record"',
        ),
      ),
    ).toContain('duplicate_object_key:"id"');
  });

  it('preserves valid strings, escapes, Unicode, arrays, and JSON number spellings', () => {
    const plan = validPlan();
    plan.title = 'Literal {"version":99,"version":1}, quote: " and Unicode: café 東京';
    plan.clarifyingQuestions = ['Does text like ] }, { "id":"id" stay text?'];
    const raw = JSON.stringify(plan)
      .replace('café 東京', 'caf\\u00e9 \\u6771\\u4eac')
      .replace('"tokens":7000', '"tokens":7e3');
    expect(validateResearchPlan(raw, context)).toMatchObject({
      title: plan.title,
      budget: { tokens: 7_000 },
      clarifyingQuestions: plan.clarifyingQuestions,
    });
  });

  it('rejects duplicate IDs, dependencies that do not resolve, and cycles', () => {
    const duplicate = validPlan();
    duplicate.steps[1]!.id = duplicate.steps[0]!.id;
    expect(issuesFor(duplicate)).toContain('duplicate_step_id:verify-client-record');

    const unknown = validPlan();
    unknown.steps[1]!.dependsOn = ['missing-step'];
    expect(issuesFor(unknown)).toContain('unknown_dependency:check-public-status:missing-step');

    const cyclic = validPlan();
    cyclic.steps[0]!.dependsOn = ['check-public-status'];
    expect(issuesFor(cyclic)).toContain('dependency_cycle');
  });

  it('rejects scope drift, unavailable capabilities, and writes disguised as reads', () => {
    const scopeMismatch = validPlan();
    scopeMismatch.scope.clientId = 'other-client';
    expect(issuesFor(scopeMismatch)).toContain('scope_mismatch:clientId');

    const unknownCapability = validPlan();
    unknownCapability.steps[0]!.allowedCapabilities = ['invented_tool'];
    expect(issuesFor(unknownCapability)).toContain(
      'steps[0].capability_unavailable:invented_tool',
    );

    const disallowedWrite = validPlan();
    disallowedWrite.steps[0]!.allowedCapabilities = ['send_email'];
    expect(issuesFor(disallowedWrite)).toContain(
      'steps[0].write_capability_requires_approval:send_email',
    );
  });

  it('allows a canonical business action only as approval-required planning', () => {
    const plan = validPlan();
    plan.steps[1] = {
      ...plan.steps[1]!,
      allowedCapabilities: ['send_email'],
      effect: 'approval_required',
    };
    expect(validateResearchPlan(plan, context).steps[1]).toMatchObject({
      effect: 'approval_required',
      allowedCapabilities: ['send_email'],
    });
  });

  it('rejects overallocated, underdeclared, non-finite, and oversized budgets', () => {
    const over = validPlan();
    over.steps[1]!.budget.tokens = RESEARCH_PLAN_LIMITS.maxTotalTokens;
    over.budget.tokens = RESEARCH_PLAN_LIMITS.maxTotalTokens + 2_000;
    expect(issuesFor(over)).toContain(
      `budget_tokens_exceeds_${RESEARCH_PLAN_LIMITS.maxTotalTokens}`,
    );

    const mismatch = validPlan();
    mismatch.budget.toolCalls = 2;
    expect(issuesFor(mismatch)).toContain('budget_tool_calls_must_equal_step_allocations');

    const infinite = validPlan();
    infinite.steps[0]!.budget.tokens = Number.POSITIVE_INFINITY;
    expect(issuesFor(infinite)).toContain('steps[0].budget.tokens_must_be_positive_integer');

    expect(
      issuesFor(' '.repeat(RESEARCH_PLAN_LIMITS.maxSerializedChars + 1)),
    ).toContain('plan_too_large');
  });

  it('builds a tenant-current prompt from the supplied canonical catalog', () => {
    const prompt = buildResearchPlanSystemPrompt('Meri', context);
    expect(prompt).toContain(JSON.stringify(context.scope));
    expect(prompt).toContain('search_memory');
    expect(prompt).toContain('send_email');
    expect(prompt).toContain('approval_required');
    expect(prompt).not.toContain('invented_tool');
  });

  it('names the string limit in the prompt, the issue, and the repair instruction', () => {
    const prompt = buildResearchPlanSystemPrompt('Meri', context);
    expect(prompt).toContain(`title at most ${RESEARCH_PLAN_LIMITS.maxTitleChars} characters`);
    expect(prompt).toContain(
      `objective, completionCondition, and each clarifying question at most ${RESEARCH_PLAN_LIMITS.maxStringChars}`,
    );

    const long = validPlan();
    long.steps[1]!.completionCondition = 'x'.repeat(RESEARCH_PLAN_LIMITS.maxStringChars + 1);
    long.title = 't'.repeat(RESEARCH_PLAN_LIMITS.maxTitleChars + 1);
    const issues = issuesFor(long);
    expect(issues).toContain(
      `steps[1].completionCondition_too_long_max_${RESEARCH_PLAN_LIMITS.maxStringChars}`,
    );
    expect(issues).toContain(`title_too_long_max_${RESEARCH_PLAN_LIMITS.maxTitleChars}`);

    const atLimit = validPlan();
    atLimit.steps[1]!.completionCondition = 'x'.repeat(RESEARCH_PLAN_LIMITS.maxStringChars);
    expect(issuesFor(atLimit)).toEqual([]);

    const repair = buildResearchPlanRepairPrompt(
      prompt,
      JSON.stringify(long),
      new ResearchPlanValidationError(issues),
    );
    expect(repair.system).toContain('_too_long_max_N');
    expect(repair.user).toContain(
      `steps[1].completionCondition_too_long_max_${RESEARCH_PLAN_LIMITS.maxStringChars}`,
    );
  });
});
