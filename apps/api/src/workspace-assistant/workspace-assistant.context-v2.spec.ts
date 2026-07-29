import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { WorkspaceAssistantService } from './workspace-assistant.service.js';

/**
 * The in-editor surface is the ContextPacket v2 template: it already reports honest
 * `degraded`/`degradedReasons`, only claims a `contextPacketId` when the row was
 * written, and its Context Inspector is already rendered by MeriPanel.
 *
 * What must hold:
 *   1. dark by default — the compile request is byte-for-byte the pre-v2 one;
 *   2. once armed, the request opts into contract v2 with a trace id and the
 *      surface's token budget, and NEVER sets `persistence` (a trace-write failure
 *      must not 500 this route);
 *   3. the same trace id comes back on the result, so the packet row and the answer
 *      can actually be correlated.
 */
describe('WorkspaceAssistantService — ContextPacket v2 wiring', () => {
  const ctx = { tenantId: 't1', userId: 'u1' } as TenantContext;

  function makeService(): {
    service: WorkspaceAssistantService;
    requests: Array<Record<string, unknown>>;
  } {
    const requests: Array<Record<string, unknown>> = [];
    const contextCompiler = {
      compile: jest.fn(async (req: Record<string, unknown>) => {
        requests.push(req);
        return {
          packetId: 'pkt-1',
          version: req.contractVersion === 2 ? 2 : 1,
          surface: 'in-editor',
          tenantId: 't1',
          effectiveTenantId: 't1',
          actorUserId: 'u1',
          userId: 'u1',
          clientId: null,
          ref: {},
          items: [],
          exclusions: [],
          rendered: [],
          traceHash: 'hash-1',
          persisted: true,
          compiledAt: '2026-07-29T12:00:00.000Z',
          ...(req.contractVersion === 2
            ? {
                traceId: req.traceId,
                promptVersion: req.promptVersion,
                policyVersion: req.policyVersion,
                compilerVersion: req.compilerVersion,
                requiredLayers: req.layers,
                health: {
                  status: 'healthy',
                  missingRequiredLayers: [],
                  conflictCount: 0,
                  sourceFailureCount: 0,
                  reasons: [],
                },
                totalTokenBudget: req.tokenBudget ?? null,
                usedTokens: 0,
                truncated: false,
                incomplete: false,
              }
            : {}),
        };
      }),
    };
    const service = new WorkspaceAssistantService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      contextCompiler as never,
      null as never,
    );
    return { service, requests };
  }

  const resolve = (service: WorkspaceAssistantService, traceId: string) =>
    (
      service as unknown as {
        resolveContextPacket: (
          c: TenantContext,
          d: unknown,
          t: string,
        ) => Promise<Record<string, unknown>>;
      }
    ).resolveContextPacket(ctx, { document: { id: 'doc-1' } }, traceId);

  const originalEnv = process.env.CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CONTEXT_PACKET_V2;
    else process.env.CONTEXT_PACKET_V2 = originalEnv;
  });

  it('is dark by default: the request carries no v2 field at all', async () => {
    const { service, requests } = makeService();
    await resolve(service, 'trace-1');
    expect(requests[0]).toEqual({
      tenantId: 't1',
      userId: 'u1',
      clientId: null,
      surface: 'in-editor',
      layers: ['firm-identity', 'user-voice'],
      ref: { documentId: 'doc-1' },
    });
  });

  it('stays dark for every value that is not exactly "enforce"', async () => {
    for (const raw of ['', 'true', '1', 'on', 'v2', 'ENFORCED']) {
      process.env.CONTEXT_PACKET_V2 = raw;
      const { service, requests } = makeService();
      await resolve(service, 'trace-1');
      expect(requests[0]).not.toHaveProperty('contractVersion');
    }
  });

  it('opts into v2 with the surface budget and the caller trace id once armed', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const { service, requests } = makeService();
    await resolve(service, 'trace-1');
    expect(requests[0]).toEqual(
      expect.objectContaining({
        contractVersion: 2,
        traceId: 'trace-1',
        promptVersion: 'legacy-in-editor-v2',
        policyVersion: 'context-policy-v2.0',
        compilerVersion: 'context-compiler-v2.0',
        tokenBudget: 6_000,
        budgetUnit: 'tokens',
        // Layers stay EXPLICIT: no client in scope means the packet must not claim
        // a missing client layer.
        layers: ['firm-identity', 'user-voice'],
      }),
    );
    // A diagnostics trace failure must never become a 500 on this route.
    expect(requests[0]).not.toHaveProperty('persistence');
  });

  it('returns the trace id only for a v2 packet, so absence is never mistaken for success', () => {
    const { service } = makeService();
    const finish = (
      service as unknown as {
        finish: (p: unknown, e: unknown, r: unknown) => Record<string, unknown>;
      }
    ).finish.bind(service);
    const base = {
      packetId: 'pkt-1',
      traceHash: 'hash-1',
      items: [],
      exclusions: [],
      persisted: true,
    };
    expect(finish({ ...base, version: 1 }, {}, { reply: 'ok', edits: [] }).contextTraceId).toBeNull();
    expect(
      finish({ ...base, version: 2, traceId: 'trace-9' }, {}, { reply: 'ok', edits: [] })
        .contextTraceId,
    ).toBe('trace-9');
  });
});
