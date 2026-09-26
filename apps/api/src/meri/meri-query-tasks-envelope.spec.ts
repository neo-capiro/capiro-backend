import {
  envelopeQueryTasksResult,
  observeQueryTasksCall,
} from './meri-query-tasks-envelope.js';

function payload(input: Partial<Record<string, unknown>> = {}) {
  const tasks = (input.tasks as unknown[] | undefined) ?? [];
  const pageLimit = input.pageLimit ?? 25;
  const full = tasks.length === pageLimit;
  return {
    tool: 'query_tasks',
    generatedAt: '2026-09-25T12:00:00.000Z',
    total: full ? null : tasks.length,
    returned: tasks.length,
    pageLimit,
    paginationComplete: !full,
    tasks,
    ...input,
  };
}

describe('query_tasks result envelope (dormant observer)', () => {
  it('maps a consistent short page as complete without treating generatedAt as freshness', () => {
    const legacy = payload({ tasks: [{ id: 'task-a' }], pageLimit: 5 });
    const envelope = envelopeQueryTasksResult(legacy, { clientFilterApplied: true });

    expect(envelope).toMatchObject({
      outcome: 'succeeded',
      legacyPayload: legacy,
      sources: [{
        family: 'task',
        sourceId: 'engagement_tasks',
        availability: 'available',
        scope: {
          tenantScope: 'authenticated_tenant',
          visibilityScope: 'handler_query_scope_filters_not_recorded',
          clientFilterApplied: true,
        },
        observedAt: null,
        coverage: {
          completeness: 'complete',
          continuation: { hasMore: false },
          returnedCount: 1,
          matchedCount: 1,
        },
      }],
      truncation: { truncated: false },
      errors: [],
    });
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.sources[0]!.observedAt).toBeNull();
  });

  it('does not turn an empty page into an absence claim when filters are not recorded', () => {
    const envelope = envelopeQueryTasksResult(payload({ tasks: [], pageLimit: 10 }), {
      clientFilterApplied: false,
    });
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources[0]!.coverage.completeness).toBe('complete');
    expect(envelope.sources[0]!.scope.clientFilterApplied).toBe(false);
    expect(envelope.sources[0]!.scope.visibilityScope).toBe('handler_query_scope_filters_not_recorded');
  });

  it('keeps a valid full page partial without claiming definite continuation', () => {
    const full = Array.from({ length: 2 }, (_, index) => ({ id: `task-${index}` }));
    const envelope = envelopeQueryTasksResult(payload({ tasks: full, pageLimit: 2 }), {
      clientFilterApplied: false,
    });

    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]!.coverage).toEqual({
      completeness: 'partial',
      returnedCount: 2,
      matchedCount: null,
    });
    expect(envelope.sources[0]!.coverage).not.toHaveProperty('continuation');
    expect(envelope.truncation.truncated).toBe(true);
  });

  it('keeps contradictory full-page metadata unknown and without a definite continuation claim', () => {
    const full = Array.from({ length: 2 }, (_, index) => ({ id: `task-${index}` }));
    const envelope = envelopeQueryTasksResult(payload({
      tasks: full,
      pageLimit: 2,
      total: 2,
      paginationComplete: true,
    }), { clientFilterApplied: false });

    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]!.coverage).toMatchObject({
      completeness: 'unknown',
      returnedCount: 2,
      matchedCount: null,
    });
    expect(envelope.sources[0]!.coverage).not.toHaveProperty('continuation');
    expect(envelope.sources[0]!.observedAt).toBeNull();
  });

  it('does not attribute complete or empty scope to an unidentified payload', () => {
    const foreign = payload({ tool: 'another_tool', tasks: [], pageLimit: 10 });
    const envelope = envelopeQueryTasksResult(foreign, { clientFilterApplied: false });

    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'unknown',
      coverage: { completeness: 'unknown', matchedCount: null },
      scope: { tenantScope: 'unknown' },
    });
    expect(envelope.sources[0]!.scope).not.toHaveProperty('visibilityScope');
    expect(envelope.sources[0]!.scope).not.toHaveProperty('clientFilterApplied');
    expect(envelope.sources[0]!.coverage).not.toHaveProperty('continuation');
    expect(envelope.truncation.truncated).toBe(true);
    expect(envelope.errors).toEqual([{ code: 'query_tasks_coverage_unverified' }]);
  });

  it('keeps malformed or contradictory coverage unknown', () => {
    const envelope = envelopeQueryTasksResult(payload({
      tasks: [{ id: 'task-a' }],
      returned: 2,
      pageLimit: 5,
    }), { clientFilterApplied: false });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]!.coverage.completeness).toBe('unknown');
    expect(envelope.errors).toEqual([{ code: 'query_tasks_coverage_unverified' }]);
  });

  it('returns the original payload and preserves a rejected call value by identity', async () => {
    const legacy = payload({ tasks: [{ id: 'task-a' }], pageLimit: 4 });
    const observe = jest.fn();
    await expect(observeQueryTasksCall(async () => legacy, { clientFilterApplied: false }, observe))
      .resolves.toBe(legacy);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ legacyPayload: legacy }));

    const error = new Error('private authorization failure');
    await expect(observeQueryTasksCall(async () => { throw error; }, { clientFilterApplied: false }, observe))
      .rejects.toBe(error);
  });

  it('swallows observer failures without changing the successful legacy result', async () => {
    const legacy = payload({ tasks: [], pageLimit: 5 });
    await expect(observeQueryTasksCall(
      async () => legacy,
      { clientFilterApplied: false },
      () => { throw new Error('observer unavailable'); },
    )).resolves.toBe(legacy);
  });
});
