import { defineContextOperation } from '@capiro/meriv2-core';
import * as operationRegistry from './context-plane-operation-registry.js';
import { ContextPlaneGatewayService } from './context-plane-gateway.service.js';
import type { ContextPlaneOperationRegistration } from './context-plane-operation-registry.js';
import type { ContextResolutionRequest } from './context-resolver.types.js';
import type { ContextRequest } from '@capiro/meriv2-core';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function resolverRequest(
  surface: ContextResolutionRequest['surface'] = 'research',
): ContextResolutionRequest {
  return {
    tenantId: TENANT,
    actorUserId: USER,
    surface,
    task: 'test context operation',
    securityScope: {},
    subjectScope: 'general',
  };
}

function contextRequest(surface: ContextRequest['surface'] = 'research'): ContextRequest {
  return {
    tenantId: TENANT,
    effectiveTenantId: TENANT,
    userId: USER,
    actorUserId: USER,
    surface,
    layers: [],
  };
}

function governedOperation(): ContextPlaneOperationRegistration {
  return {
    registration: defineContextOperation({
      id: 'test.governed-operation',
      product: 'test',
      surface: 'research',
    }),
    resolverSurface: 'research',
    owner: 'test',
  };
}

function harness(mode: 'off' | 'shadow' | 'enforce' = 'enforce') {
  const context = { resolution: { status: 'ready' } } as never;
  const resolver = { resolveAndRetrieve: jest.fn().mockResolvedValue(context) };
  const packets = {
    compile: jest.fn().mockResolvedValue({
      version: 2,
      packetId: '33333333-3333-3333-3333-333333333333',
      traceHash: 'phase18-hash',
      persisted: true,
      retrievalCompleteness: 'complete',
      retrievalStopReason: 'complete',
    }),
  };
  const compiler = { modeFor: jest.fn().mockResolvedValue(mode) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ContextPlaneGatewayService(
    resolver as never,
    packets as never,
    compiler as never,
    audit as never,
  );
  return { service, resolver, packets, compiler, audit, context };
}

describe('ContextPlaneGatewayService Phase 18-26', () => {
  afterEach(() => jest.restoreAllMocks());

  test('unregistered operation is denied and audited before resolver/retrieval', async () => {
    const h = harness();
    await expect(
      h.service.requestContext({
        operationId: 'rogue.feature-rag',
        resolverRequest: resolverRequest(),
        contextRequest: contextRequest(),
      }),
    ).rejects.toMatchObject({ status: 403 });

    expect(h.resolver.resolveAndRetrieve).not.toHaveBeenCalled();
    expect(h.packets.compile).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          allowed: false,
          reason: 'operation_not_registered',
        }),
      }),
    );
  });

  test.each([
    ['strategies.generate', 'strategy', 'strategy', 25],
    ['meetings.prep-debrief', 'engagement', 'memo', 24],
    ['crm.fill-with-meri', 'client-profile', 'research', 23],
    ['legiwatch.generate-report', 'legiwatch', 'memo', 22],
    ['workspace.generate', 'workspace-gen', 'workspace-gen', 21],
    ['workspace.editor-assist', 'workspace-editor', 'workspace-editor', 21],
    ['outreach.generate', 'outreach', 'outreach', 20],
    ['meri.chat', 'chat', 'chat', 19],
    ['meri.research', 'research', 'research', 19],
    ['research.generate-report', 'research', 'research', 19],
  ] as const)(
    '%s is packet-required',
    async (operationId, resolverSurface, packetSurface, phase) => {
      const h = harness('enforce');
      const resolverReq = resolverRequest(resolverSurface);
      const compilerReq = contextRequest(packetSurface);

      const result = await h.service.requestContext({
        operationId,
        resolverRequest: resolverReq,
        contextRequest: compilerReq,
        currentPhase: phase,
      });

      expect(result.kind).toBe('governed_packet');
      expect(h.resolver.resolveAndRetrieve).toHaveBeenCalledWith(resolverReq);
      expect(h.packets.compile).toHaveBeenCalledWith(compilerReq, h.context, undefined);
    },
  );

  test('packet-required operation can only reach reasoning through resolver and ContextPacket V2', async () => {
    jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
    const h = harness('enforce');
    const resolverReq = resolverRequest();
    resolverReq.retrieval = {
      queryClass: 'lookup',
      requestedDomains: ['clients'],
    };
    const compilerReq = contextRequest();

    const result = await h.service.requestContext({
      operationId: 'test.governed-operation',
      resolverRequest: resolverReq,
      contextRequest: compilerReq,
    });

    expect(result.kind).toBe('governed_packet');
    expect(h.resolver.resolveAndRetrieve).toHaveBeenCalledWith(resolverReq);
    expect(h.packets.compile).toHaveBeenCalledWith(compilerReq, h.context, resolverReq.retrieval);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ reason: 'governed_packet' }),
        packet: expect.objectContaining({
          version: 2,
          retrievalCompleteness: 'complete',
        }),
      }),
    );
  });

  test('enforce mode denies a packet-required operation if the compiler returns v1', async () => {
    jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
    const h = harness('enforce');
    h.packets.compile.mockResolvedValue({ version: 1 } as never);

    await expect(
      h.service.requestContext({
        operationId: 'test.governed-operation',
        resolverRequest: resolverRequest(),
        contextRequest: contextRequest(),
      }),
    ).rejects.toMatchObject({ status: 403 });

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ reason: 'governed_packet_required' }),
      }),
    );
  });

  test('off/shadow remains an explicit audited rollback for registered operations', async () => {
    jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
    const h = harness('shadow');
    h.packets.compile.mockResolvedValue({ version: 1, traceHash: 'legacy' } as never);

    const result = await h.service.requestContext({
      operationId: 'test.governed-operation',
      resolverRequest: resolverRequest(),
      contextRequest: contextRequest(),
    });

    expect(result.kind).toBe('release_switch_rollback');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutMode: 'shadow',
        decision: expect.objectContaining({ reason: 'release_switch_rollback' }),
      }),
    );
  });

  test('tenant/actor mismatch fails closed before rollout lookup or retrieval', async () => {
    jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
    const h = harness();
    const resolverReq = resolverRequest();
    resolverReq.actorUserId = '44444444-4444-4444-4444-444444444444';

    await expect(
      h.service.requestContext({
        operationId: 'test.governed-operation',
        resolverRequest: resolverReq,
        contextRequest: contextRequest(),
      }),
    ).rejects.toMatchObject({ status: 403 });

    expect(h.compiler.modeFor).not.toHaveBeenCalled();
    expect(h.resolver.resolveAndRetrieve).not.toHaveBeenCalled();
    expect(h.packets.compile).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutMode: 'not_evaluated',
        decision: expect.objectContaining({ reason: 'operation_scope_mismatch' }),
      }),
    );
  });

  test('registered resolver/packet surface mismatch fails before rollout lookup', async () => {
    jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
    const h = harness();

    await expect(
      h.service.requestContext({
        operationId: 'test.governed-operation',
        resolverRequest: resolverRequest('memo'),
        contextRequest: contextRequest(),
      }),
    ).rejects.toMatchObject({ status: 403 });

    expect(h.compiler.modeFor).not.toHaveBeenCalled();
    expect(h.resolver.resolveAndRetrieve).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        rolloutMode: 'not_evaluated',
        decision: expect.objectContaining({ reason: 'operation_surface_mismatch' }),
      }),
    );
  });

  // -- Stage observability -------------------------------------------------
  //
  // Phase 27 cannot establish a quality/cost/latency baseline from durations
  // that only exist in memory. These land on the EXISTING Context Plane audit
  // row, so they become queryable in production without a second store.
  describe('stage telemetry on the audit row', () => {
    function governedCall(h: ReturnType<typeof harness>) {
      const compilerReq = contextRequest();
      compilerReq.layers = ['firm-identity', 'user-voice'];
      compilerReq.traceId = 'trace-abc';
      return h.service.requestContext({
        operationId: 'test.governed-operation',
        resolverRequest: resolverRequest(),
        contextRequest: compilerReq,
      });
    }

    test('records every stage duration, the trace id and the coverage vector', async () => {
      jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
      const h = harness('enforce');
      h.resolver.resolveAndRetrieve.mockResolvedValue({
        resolution: {
          status: 'ready',
          stopReason: 'context_resolved_for_retrieval',
          subjectScope: { kind: 'client', clientIds: ['c-1'] },
          retrievalAllowed: true,
        },
        retrieval: {
          records: [],
          coverage: {
            requestedDomains: ['clients', 'mail'],
            searchedDomains: ['clients'],
            recordsEvaluated: 4,
            recordsReturned: 0,
            paginationComplete: false,
            unavailableSources: ['mail'],
            sources: [
              {
                domain: 'clients',
                sourceStatus: 'degraded',
                coverageComplete: false,
                truncated: true,
              },
              { domain: 'mail', sourceStatus: 'unauthorized', coverageComplete: false },
            ],
            complete: false,
            stopReason: 'source_partial',
          },
        },
      } as never);

      await governedCall(h);

      const recorded = h.audit.record.mock.calls.at(-1)?.[0];
      expect(recorded.traceId).toBe('trace-abc');
      expect(recorded.timings).toEqual(expect.objectContaining({ totalMs: expect.any(Number) }));
      // Compilation is timed at the gateway, so it is always populated here.
      expect(recorded.timings.compileMs).not.toBeNull();
      expect(recorded.resolution).toEqual(
        expect.objectContaining({
          status: 'ready',
          subjectScopeKind: 'client',
          subjectClientCount: 1,
          retrievalAllowed: true,
        }),
      );
      // zero results !== complete coverage: every degraded state stays distinct.
      expect(recorded.coverage).toEqual(
        expect.objectContaining({
          ran: true,
          complete: false,
          recordsReturned: 0,
          recordsEvaluated: 4,
          missingDomains: ['mail'],
          partialDomains: ['clients'],
          paginationComplete: false,
          truncated: true,
          stopReason: 'source_partial',
        }),
      );
      expect(recorded.coverage.unavailableDomains).toEqual(['mail']);
      expect(recorded.coverage.sourceStatuses).toEqual({
        clients: 'degraded',
        mail: 'unauthorized',
      });
      expect(recorded.requestedLayers).toEqual(['firm-identity', 'user-voice']);
    });

    test('retrieval that never ran is incomplete, not complete-with-zero-results', async () => {
      jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
      const h = harness('enforce');
      h.resolver.resolveAndRetrieve.mockResolvedValue({
        resolution: { status: 'ambiguous', retrievalAllowed: false },
      } as never);

      await governedCall(h);

      const recorded = h.audit.record.mock.calls.at(-1)?.[0];
      expect(recorded.coverage).toEqual(
        expect.objectContaining({
          ran: false,
          complete: false,
          stopReason: 'retrieval_not_run',
        }),
      );
    });

    test('packet layer presence and the reason a layer was dropped are recorded', async () => {
      jest.spyOn(operationRegistry, 'contextPlaneOperation').mockReturnValue(governedOperation());
      const h = harness('enforce');
      h.packets.compile.mockResolvedValue({
        version: 2,
        packetId: '33333333-3333-3333-3333-333333333333',
        traceHash: 'phase18-hash',
        persisted: true,
        retrievalCompleteness: 'complete',
        retrievalStopReason: 'complete',
        requiredLayers: ['firm-identity', 'user-voice'],
        health: {
          status: 'degraded',
          reasons: ['missing_required_layer'],
          missingRequiredLayers: ['firm-identity'],
        },
        items: [{ id: 'm-1', layer: 'user-voice' }],
        exclusions: [{ layer: 'firm-identity', reason: 'unapproved' }],
        rendered: [{ id: 'm-1', layer: 'user-voice', body: 'abcde' }],
        totalTokenBudget: 8000,
        usedTokens: 120,
      } as never);

      await governedCall(h);

      const recorded = h.audit.record.mock.calls.at(-1)?.[0];
      // 'requested and dropped as unapproved' must stay distinguishable from
      // 'never requested'. That distinction is what makes an absent
      // institutional layer diagnosable in production at all.
      expect(recorded.packet.presentLayers).toEqual(['user-voice']);
      expect(recorded.packet.missingLayers).toEqual(['firm-identity']);
      expect(recorded.packet.exclusionReasonsByLayer).toEqual({
        'firm-identity': ['unapproved'],
      });
      expect(recorded.packet.health).toBe('degraded');
      expect(recorded.packet.healthReasons).toEqual(['missing_required_layer']);
      expect(recorded.packet.tokenBudget).toBe(8000);
      expect(recorded.packet.tokensUsed).toBe(120);
      // Length of rendered context only; the rendered text never leaves.
      expect(recorded.packet.blockChars).toBe(5);
      expect(JSON.stringify(recorded)).not.toContain('abcde');
    });
  });
});
