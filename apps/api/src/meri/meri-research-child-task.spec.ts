import {
  boundResearchChildGoal,
  completeResearchChildTask,
  createResearchChildTaskBatch,
  currentResearchGoalRevision,
  failResearchChildTask,
  persistResearchChildTaskBatch,
  readResearchChildTasks,
  researchChildEvidenceHandles,
  validateResearchChildOutput,
  type ResearchChildStructuredOutputV1,
} from './meri-research-child-task.js';
import type { ResearchPlanV1 } from './meri-research-plan.js';

const scope = {
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  actorId: 'actor-1',
  clientId: 'client-1',
  conversationId: 'conversation-1',
};
const run = { id: 'run-1', leaseEpoch: 4 };
const plan: ResearchPlanV1 = {
  version: 1,
  title: 'Bounded child research',
  scope,
  budget: { toolCalls: 4, tokens: 4_000 },
  steps: [
    {
      id: 'memory',
      objective: 'Review current institutional memory',
      dependsOn: [],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'Current memory reviewed',
      budget: { toolCalls: 2, tokens: 2_000 },
    },
    {
      id: 'documents',
      objective: 'Review current client documents',
      dependsOn: [],
      requiredEvidenceDomains: ['documents'],
      allowedCapabilities: ['read_client_documents'],
      effect: 'read',
      completionCondition: 'Documents reviewed',
      budget: { toolCalls: 2, tokens: 2_000 },
    },
  ],
  clarifyingQuestions: [],
};

function tasks(firstGoal = 'Review the current evidence for the first admitted read step.') {
  return createResearchChildTaskBatch({
    specs: [
      {
        id: 'child:one',
        role: 'evidence_reviewer',
        goal: firstGoal,
        allowedCapabilities: ['search_memory'],
      },
      {
        id: 'child:two',
        role: 'scope_analyst',
        goal: 'Review the current evidence for the second admitted read step.',
        allowedCapabilities: ['read_client_documents'],
      },
    ],
    run,
    scope,
    parentPlan: plan,
    parentAllowedReadCapabilities: ['read_client_documents', 'search_memory'],
    evidenceHandles: [],
    goalRevision: 3,
    modelConfig: {
      policy: 'current_approved_research_model',
      provider: 'openai',
      modelSelection: 'server_resolved',
      reasoningMode: 'deep',
      allowProviderFallback: false,
    },
    deadlineAt: '2026-09-28T13:00:00.000Z',
  });
}

function output(goalRevision = 3): ResearchChildStructuredOutputV1 {
  return {
    version: 1,
    goalRevision,
    findings: [
      {
        id: 'funding-finding',
        statement: 'The current source supports the bounded finding.',
        evidenceHandles: ['search_memory:record-1'],
        confidence: 'high',
      },
    ],
    limitations: ['Only the admitted source scope was reviewed.'],
  };
}

describe('bounded research child-task contract', () => {
  it('creates exactly two leaf children with shared parent budget references', () => {
    const batch = tasks();
    expect(batch).toHaveLength(2);
    expect(batch).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generation: 1,
          delegationAllowed: false,
          budgetRefs: { tool: 'researchToolBudget', provider: 'researchProviderBudget' },
          modelConfig: expect.objectContaining({
            policy: 'current_approved_research_model',
            modelSelection: 'server_resolved',
            allowProviderFallback: false,
          }),
          goalRevision: 3,
          attempt: 1,
        }),
      ]),
    );
  });

  it('bounds a long joined goal without leaving edge whitespace', () => {
    // A cut that lands just after a space used to fail the whole run with
    // research_child_goal_invalid before any step started.
    const objective = `${'a'.repeat(1_999)} next objective`;
    expect(objective.slice(0, 2_000).endsWith(' ')).toBe(true);
    const goal = boundResearchChildGoal(objective);
    expect(goal).toHaveLength(1_999);
    expect(goal.trim()).toBe(goal);
    expect(tasks(goal)[0]?.goal).toBe(goal);
    expect(() => tasks(objective.slice(0, 2_000))).toThrow('research_child_goal_invalid');
    expect(boundResearchChildGoal('Short goal.')).toBe('Short goal.');
  });

  it('rejects broader capabilities and a child-selected model route', () => {
    expect(() =>
      createResearchChildTaskBatch({
        ...baseInput(),
        specs: [
          {
            id: 'child:one',
            role: 'evidence_reviewer',
            goal: 'Attempt an inadmissible action.',
            allowedCapabilities: ['send_email'],
          },
          baseInput().specs[1]!,
        ],
      }),
    ).toThrow('research_child_capability_expansion_denied');
    expect(() =>
      createResearchChildTaskBatch({
        ...baseInput(),
        modelConfig: {
          ...baseInput().modelConfig,
          modelSelection: 'caller_selected',
        } as never,
      }),
    ).toThrow('research_child_model_config_invalid');
  });

  it.each([
    ['malformed JSON', '{not-json}', 'research_child_output_malformed'],
    [
      'arbitrary extra permission',
      JSON.stringify({ ...output(), allowedCapabilities: ['send_email'] }),
      'research_child_output_schema_invalid',
    ],
    ['wrong revision', JSON.stringify(output(2)), 'research_child_goal_revision_mismatch'],
    [
      'unknown reference ID',
      JSON.stringify(output()),
      'research_child_evidence_handle_unavailable',
    ],
    [
      'finding without evidence references',
      JSON.stringify({
        ...output(),
        findings: [{ ...output().findings[0], evidenceHandles: [] }],
      }),
      'research_child_output_schema_invalid',
    ],
    [
      'duplicate object key',
      '{"version":1,"version":1,"goalRevision":3,"findings":[],"limitations":[]}',
      'research_child_output_malformed',
    ],
  ])('rejects %s', (_name, raw, code) => {
    expect(() =>
      validateResearchChildOutput(raw, {
        goalRevision: 3,
        allowedEvidenceHandles:
          code === 'research_child_evidence_handle_unavailable'
            ? ['search_memory:different-record']
            : ['search_memory:record-1'],
      }),
    ).toThrow(code);
  });

  it('rejects oversized output before parsing it', () => {
    expect(() =>
      validateResearchChildOutput('x'.repeat(32_001), {
        goalRevision: 3,
        allowedEvidenceHandles: [],
      }),
    ).toThrow('research_child_output_too_large');
  });

  it('persists tasks before completion and preserves unrelated coordinator/budget metadata', () => {
    const metadata = {
      durableCoordinator: { version: 1, goalRevision: 3, pending: 'owned elsewhere' },
      researchProviderBudget: { retained: true },
      researchToolBudget: { retained: true },
      unrelated: { retained: true },
    };
    const persisted = persistResearchChildTaskBatch({ metadata, run, tasks: tasks() });
    const completed = completeResearchChildTask({
      metadata: persisted,
      run,
      goalRevision: 3,
      taskId: 'child:one',
      output: output(),
      model: 'current-approved-model',
      provider: 'openai',
      allowedEvidenceHandles: ['search_memory:record-1'],
      now: new Date('2026-09-28T12:30:00.000Z'),
    });
    expect(completed).toMatchObject(metadata);
    expect(readResearchChildTasks(completed)[0]).toMatchObject({
      status: 'completed',
      result: {
        taskId: 'child:one',
        goalRevision: 3,
        evidenceHandles: ['search_memory:record-1'],
      },
    });
  });

  it('fences late old-owner and old-revision completion and records typed failures', () => {
    const metadata = persistResearchChildTaskBatch({ metadata: {}, run, tasks: tasks() });
    expect(() =>
      completeResearchChildTask({
        metadata,
        run: { id: 'new-owner', leaseEpoch: 5 },
        goalRevision: 3,
        taskId: 'child:one',
        output: output(),
        model: 'current-approved-model',
        provider: 'openai',
        allowedEvidenceHandles: ['search_memory:record-1'],
      }),
    ).toThrow('research_child_stale_owner');
    expect(() =>
      completeResearchChildTask({
        metadata,
        run,
        goalRevision: 4,
        taskId: 'child:one',
        output: output(),
        model: 'current-approved-model',
        provider: 'openai',
        allowedEvidenceHandles: ['search_memory:record-1'],
      }),
    ).toThrow('research_child_goal_revision_mismatch');

    const failed = failResearchChildTask({
      metadata,
      run,
      goalRevision: 3,
      taskId: 'child:one',
      failure: { code: 'schema_invalid', message: 'Strict output validation failed.' },
      now: new Date('2026-09-28T12:31:00.000Z'),
    });
    expect(readResearchChildTasks(failed)[0]).toMatchObject({
      status: 'failed',
      result: null,
      failure: { code: 'schema_invalid' },
    });
  });

  it('uses coordinator revision when present and rejects malformed revision ownership', () => {
    expect(currentResearchGoalRevision({})).toBe(0);
    expect(currentResearchGoalRevision({ durableCoordinator: { goalRevision: 7 } })).toBe(7);
    expect(() =>
      currentResearchGoalRevision({ durableCoordinator: { goalRevision: '7' } }),
    ).toThrow('research_child_goal_revision_unavailable');
  });

  it('rejects a first completion at or after the child deadline', () => {
    const metadata = persistResearchChildTaskBatch({ metadata: {}, run, tasks: tasks() });
    expect(() =>
      completeResearchChildTask({
        metadata,
        run,
        goalRevision: 3,
        taskId: 'child:one',
        output: output(),
        model: 'current-approved-model',
        provider: 'openai',
        allowedEvidenceHandles: ['search_memory:record-1'],
        now: new Date('2026-09-28T13:00:00.000Z'),
      }),
    ).toThrow('research_child_deadline_exceeded');
    expect(readResearchChildTasks(metadata)[0]?.status).toBe('pending');
  });

  it('revokes a persisted completion when current source ownership fails', () => {
    const persisted = persistResearchChildTaskBatch({ metadata: {}, run, tasks: tasks() });
    const completed = completeResearchChildTask({
      metadata: persisted,
      run,
      goalRevision: 3,
      taskId: 'child:one',
      output: output(),
      model: 'current-approved-model',
      provider: 'openai',
      allowedEvidenceHandles: ['search_memory:record-1'],
      now: new Date('2026-09-28T12:30:00.000Z'),
    });
    const revoked = failResearchChildTask({
      metadata: completed,
      run,
      goalRevision: 3,
      taskId: 'child:one',
      failure: { code: 'source_not_current', message: 'Current owner rejected source reuse.' },
    });
    expect(readResearchChildTasks(revoked)[0]).toMatchObject({
      status: 'failed',
      result: null,
      failure: { code: 'source_not_current' },
    });
  });

  it('archives an interrupted old-owner batch when a new lease reclaims the run', () => {
    const first = persistResearchChildTaskBatch({ metadata: {}, run, tasks: tasks() });
    const reclaimedRun = { id: 'run-2', leaseEpoch: 5 };
    const replacement = createResearchChildTaskBatch({
      ...baseInput(),
      run: reclaimedRun,
      specs: [
        { ...baseInput().specs[0]!, id: 'child:new-one' },
        { ...baseInput().specs[1]!, id: 'child:new-two' },
      ],
    });
    const reclaimed = persistResearchChildTaskBatch({
      metadata: first,
      run: reclaimedRun,
      tasks: replacement,
    });
    expect(readResearchChildTasks(reclaimed).map((task) => task.parentRunId)).toEqual([
      'run-2',
      'run-2',
    ]);
    expect(reclaimed.researchChildTaskHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tasks: expect.arrayContaining([expect.objectContaining({ parentRunId: 'run-1' })]),
        }),
      ]),
    );
  });

  it('derives only bounded canonical evidence handles from existing citation contracts', () => {
    expect(
      researchChildEvidenceHandles([
        {
          n: 1,
          type: 'memory',
          id: 'memory-1',
          title: 'Memory',
          url: null,
          snippet: null,
          tool: 'search_memory',
        },
        {
          n: 2,
          type: 'document',
          id: '',
          stableId: 'document-2',
          title: 'Document',
          url: null,
          snippet: null,
          tool: 'read_client_documents',
        },
      ]),
    ).toEqual(['read_client_documents:document-2', 'search_memory:memory-1']);
  });
});

function baseInput() {
  return {
    specs: [
      {
        id: 'child:one',
        role: 'evidence_reviewer' as const,
        goal: 'Review the current evidence for the first admitted read step.',
        allowedCapabilities: ['search_memory'],
      },
      {
        id: 'child:two',
        role: 'scope_analyst' as const,
        goal: 'Review the current evidence for the second admitted read step.',
        allowedCapabilities: ['read_client_documents'],
      },
    ],
    run,
    scope,
    parentPlan: plan,
    parentAllowedReadCapabilities: ['read_client_documents', 'search_memory'],
    evidenceHandles: [],
    goalRevision: 3,
    modelConfig: {
      policy: 'current_approved_research_model' as const,
      provider: 'openai' as const,
      modelSelection: 'server_resolved' as const,
      reasoningMode: 'deep' as const,
      allowProviderFallback: false as const,
    },
    deadlineAt: '2026-09-28T13:00:00.000Z',
  };
}
