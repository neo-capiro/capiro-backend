import { describe, expect, it } from '@jest/globals';
import {
  RESEARCH_PLAN_LIMITS,
  ResearchPlanValidationError,
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
    clarifyingQuestions: [],
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
});
