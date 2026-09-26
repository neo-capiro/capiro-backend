import {
  envelopeQueryActionItemsResult,
  observeQueryActionItemsCall,
} from './meri-query-action-items-envelope.js';

const scope = { clientFilterApplied: true, statusFilter: 'new' } as const;

function payload(input: Partial<Record<string, unknown>> = {}) {
  const actions = (input.actions as unknown[] | undefined) ?? [];
  const limit = input.pageLimit ?? 20;
  const total = input.total ?? actions.length;
  return {
    tool: 'query_action_items',
    generatedAt: '2026-09-25T12:00:00.000Z',
    total,
    returned: actions.length,
    pageLimit: limit,
    paginationComplete: actions.length >= Number(total),
    actions,
    ...input,
  };
}

describe('query_action_items result envelope (dormant observer)', () => {
  it('maps a consistent count-matched page and reports tenant/client/status scope', () => {
    const legacy = payload({ actions: [{ id: 'action-1', clientId: 'private-id' }], total: 1 });
    const envelope = envelopeQueryActionItemsResult(legacy, scope);

    expect(envelope).toMatchObject({
      outcome: 'succeeded',
      legacyPayload: legacy,
      sources: [{
        family: 'action',
        sourceId: 'action_recommendations',
        availability: 'available',
        scope: {
          tenantScope: 'authenticated_tenant',
          visibilityScope: 'client_grant_filtered',
          attributionScope: 'selected_client',
          clientFilterApplied: true,
          statusFilter: 'new',
          dueDateFilterApplied: false,
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
    expect(envelope.sources[0]!.scope).not.toHaveProperty('clientId');
  });

  it('allows an empty exhaustive page without claiming scoped absence', () => {
    const envelope = envelopeQueryActionItemsResult(payload({ actions: [], total: 0 }), scope);
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources[0]!.coverage.completeness).toBe('complete');
    expect(envelope.outcome).not.toBe('not_found_within_scope');
  });

  it('keeps a count-consistent partial page partial without a definite continuation claim', () => {
    const envelope = envelopeQueryActionItemsResult(payload({
      actions: [{ id: 'action-1' }],
      total: 3,
      pageLimit: 1,
      paginationComplete: false,
    }), { clientFilterApplied: false, statusFilter: null });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]!.coverage).toEqual({
      completeness: 'partial',
      returnedCount: 1,
      matchedCount: 3,
    });
    expect(envelope.sources[0]!.coverage).not.toHaveProperty('continuation');
    expect(envelope.sources[0]!.scope).toMatchObject({
      tenantScope: 'authenticated_tenant',
      attributionScope: 'visible_clients_in_tenant',
      clientFilterApplied: false,
      statusFilter: null,
      dueDateFilterApplied: false,
    });
  });

  it('keeps contradictory or malformed count metadata unknown', () => {
    const envelope = envelopeQueryActionItemsResult(payload({
      actions: [{ id: 'action-1' }],
      total: 3,
      returned: 2,
      paginationComplete: true,
    }), scope);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]!.coverage).toMatchObject({
      completeness: 'unknown',
      returnedCount: 2,
      matchedCount: null,
    });
    expect(envelope.sources[0]!.coverage).not.toHaveProperty('continuation');
    expect(envelope.errors).toEqual([{ code: 'query_action_items_coverage_unverified' }]);
  });

  it('does not infer completeness for an unidentified payload', () => {
    const foreign = payload({ tool: 'different_tool', actions: [], total: 0 });
    const envelope = envelopeQueryActionItemsResult(foreign, scope);
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'unknown',
      scope: { tenantScope: 'unknown' },
      coverage: { completeness: 'unknown', matchedCount: null },
    });
    expect(envelope.sources[0]!.scope).not.toHaveProperty('clientFilterApplied');
    expect(envelope.sources[0]!.coverage).not.toHaveProperty('continuation');
  });

  it('returns the exact payload and propagates a rejected call by identity', async () => {
    const legacy = payload({ actions: [{ id: 'action-1' }] });
    const observe = jest.fn();
    await expect(observeQueryActionItemsCall(async () => legacy, scope, observe)).resolves.toBe(legacy);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ legacyPayload: legacy }));

    const error = new Error('private action-read failure');
    await expect(observeQueryActionItemsCall(async () => { throw error; }, scope, observe)).rejects.toBe(error);
  });

  it('swallows observer failures without changing the successful legacy result', async () => {
    const legacy = payload({ actions: [] });
    await expect(observeQueryActionItemsCall(async () => legacy, scope, () => {
      throw new Error('observer unavailable');
    })).resolves.toBe(legacy);
  });
});
