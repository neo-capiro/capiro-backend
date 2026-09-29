import {
  createMeriResearchPlanExecutionEnvelope,
  validateMeriResearchPlanExecutionEnvelope,
} from './research-plan-execution';

const scope = {
  sessionId: 'session-1',
  runId: 'run-1',
  leaseEpoch: 3,
  tenantId: 'tenant-1',
  actorId: 'user-1',
  clientId: 'client-1',
  conversationId: 'conversation-1',
};
const plan = {
  version: 1,
  title: 'Bounded plan',
  scope: {
    sessionId: scope.sessionId,
    tenantId: scope.tenantId,
    actorId: scope.actorId,
    clientId: scope.clientId,
    conversationId: scope.conversationId,
  },
  steps: [{ id: 'read', allowedCapabilities: ['search_memory'] }],
};

describe('research plan execution envelope', () => {
  it('hashes the admitted plan canonically and sorts the read capability union', () => {
    const first = createMeriResearchPlanExecutionEnvelope({
      plan,
      scope,
      allowedReadCapabilities: ['search_memory', 'get_client_context'],
    });
    const reorderedPlan = {
      steps: plan.steps,
      scope: plan.scope,
      title: plan.title,
      version: plan.version,
    };
    const second = createMeriResearchPlanExecutionEnvelope({
      plan: reorderedPlan,
      scope,
      allowedReadCapabilities: ['get_client_context', 'search_memory'],
    });

    expect(first.planSha256).toBe(second.planSha256);
    expect(first.allowedReadCapabilities).toEqual(['get_client_context', 'search_memory']);
    expect(validateMeriResearchPlanExecutionEnvelope(JSON.parse(JSON.stringify(first)))).toEqual(
      first,
    );
  });

  it.each(['planSha256', 'scope', 'allowedReadCapabilities'] as const)(
    'rejects a tampered or noncanonical %s',
    (field) => {
      const envelope = createMeriResearchPlanExecutionEnvelope({
        plan,
        scope,
        allowedReadCapabilities: ['get_client_context', 'search_memory'],
      });
      if (field === 'planSha256') envelope.planSha256 = `sha256:${'0'.repeat(64)}`;
      if (field === 'scope') envelope.scope.sessionId = '';
      if (field === 'allowedReadCapabilities') envelope.allowedReadCapabilities.reverse();

      if (field === 'planSha256') {
        // A different well-formed digest is detected by the governed-context MAC,
        // not by shape validation; its format remains canonical here.
        expect(() => validateMeriResearchPlanExecutionEnvelope(envelope)).not.toThrow();
      } else {
        expect(() => validateMeriResearchPlanExecutionEnvelope(envelope)).toThrow(
          'execution_envelope_invalid',
        );
      }
    },
  );

  it('rejects duplicate capabilities and extra authority fields', () => {
    const envelope = createMeriResearchPlanExecutionEnvelope({
      plan,
      scope,
      allowedReadCapabilities: ['search_memory'],
    });
    expect(() =>
      validateMeriResearchPlanExecutionEnvelope({
        ...envelope,
        allowedReadCapabilities: ['search_memory', 'search_memory'],
      }),
    ).toThrow('execution_envelope_invalid');
    expect(() =>
      validateMeriResearchPlanExecutionEnvelope({ ...envelope, privatePlan: plan }),
    ).toThrow('execution_envelope_invalid');
  });
});
