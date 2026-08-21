import type { MeriService } from './meri.service.js';
import {
  createGovernedStrategyMeriService,
} from './governed-strategy-meri.factory.js';
import { currentStrategyGovernedContext } from './strategy-governed-context.runtime.js';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const STRATEGY = '22222222-2222-4222-8222-222222222222';
const NODE = '33333333-3333-4333-8333-333333333333';

function governed(
  operationId: StrategyGovernedTurnContext['operationId'] = 'strategies.generate',
): StrategyGovernedTurnContext {
  return {
    version: 1,
    operationId,
    prompt: 'governed context',
    contextPacket: {
      packetId: 'packet-1',
      persisted: true,
      surface:
        operationId === 'workspace.generate'
          ? 'workspace-gen'
          : operationId === 'outreach.generate'
            ? 'outreach'
            : 'strategy',
      clientId: CLIENT,
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: false,
        requiredDomains: ['clients'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: ['clients'],
        searchedDomains: ['clients'],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
  };
}

function bearer(sub = 'clerk-user-1') {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('createGovernedStrategyMeriService', () => {
  test('resolves one Strategy packet before draft reasoning and exposes it request-scoped', async () => {
    const seen: Array<StrategyGovernedTurnContext | null> = [];
    const raw = {
      draft: jest.fn(async () => {
        seen.push(currentStrategyGovernedContext());
        return { ok: true };
      }),
      assistant: jest.fn(),
      draftExecutionDocument: jest.fn(),
    } as unknown as MeriService;
    const contextPlane = { compile: jest.fn().mockResolvedValue(governed()) };
    const prisma = { withTenant: jest.fn() };
    const service = createGovernedStrategyMeriService(
      raw,
      contextPlane as never,
      prisma as never,
    );

    await service.draft('tenant-1', 'clerk-user-1', bearer(), {
      clientId: CLIENT,
      type: 'appropriations',
      goal: 'Protect the request',
    });

    expect(contextPlane.compile).toHaveBeenCalledTimes(1);
    expect(contextPlane.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        clerkUserId: 'clerk-user-1',
        clientId: CLIENT,
        mode: 'draft',
        query: 'Protect the request',
      }),
    );
    expect(seen[0]?.operationId).toBe('strategies.generate');
  });

  test('loads the canonical Strategy client before assistant context resolution', async () => {
    const order: string[] = [];
    const raw = {
      draft: jest.fn(),
      assistant: jest.fn(async () => {
        order.push('raw-assistant');
        expect(currentStrategyGovernedContext()?.operationId).toBe('strategies.generate');
        return { ok: true };
      }),
      draftExecutionDocument: jest.fn(),
    } as unknown as MeriService;
    const contextPlane = {
      compile: jest.fn(async () => {
        order.push('context-plane');
        return governed();
      }),
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) => {
        order.push('strategy-load');
        return fn({
          spStrategy: {
            findFirst: jest.fn().mockResolvedValue({ clientId: CLIENT }),
          },
        });
      }),
    };
    const service = createGovernedStrategyMeriService(
      raw,
      contextPlane as never,
      prisma as never,
    );

    await service.assistant('tenant-1', 'clerk-user-1', bearer(), STRATEGY, {
      scope: 'strategy',
      instruction: 'Move the coalition step',
      clientMessageId: '44444444-4444-4444-8444-444444444444',
    });

    expect(order).toEqual(['strategy-load', 'context-plane', 'raw-assistant']);
    expect(contextPlane.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT,
        strategyId: STRATEGY,
        mode: 'assistant',
      }),
    );
  });

  test('Context Plane failure prevents draft and assistant provider reasoning', async () => {
    const raw = {
      draft: jest.fn(),
      assistant: jest.fn(),
      draftExecutionDocument: jest.fn(),
    } as unknown as MeriService;
    const contextPlane = {
      compile: jest.fn().mockRejectedValue(new Error('context_plane_unavailable')),
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
        fn({
          spStrategy: {
            findFirst: jest.fn().mockResolvedValue({ clientId: CLIENT }),
          },
        }),
      ),
    };
    // createGovernedStrategyMeriService REPLACES these methods on the same
    // instance, so `raw.draft` stops being the jest mock once it has run. Keep
    // handles to the originals or the assertion silently stops being a mock check.
    const originals = { draft: raw.draft, assistant: raw.assistant };
    const service = createGovernedStrategyMeriService(
      raw,
      contextPlane as never,
      prisma as never,
    );

    await expect(
      service.draft('tenant-1', 'clerk-user-1', bearer(), {
        clientId: CLIENT,
        type: 'appropriations',
      }),
    ).rejects.toThrow('context_plane_unavailable');
    await expect(
      service.assistant('tenant-1', 'clerk-user-1', bearer(), STRATEGY, {
        scope: 'strategy',
        instruction: 'change it',
        clientMessageId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toThrow('context_plane_unavailable');
    expect(originals.draft).not.toHaveBeenCalled();
    expect(originals.assistant).not.toHaveBeenCalled();
  });

  test.each([
    ['workspace_draft', 'workspace.generate'],
    ['outreach_record', 'outreach.generate'],
  ] as const)(
    '%s execution drafting uses destination-owned governed context',
    async (kind, operationId) => {
      const raw = {
        draft: jest.fn(),
        assistant: jest.fn(),
        draftExecutionDocument: jest.fn(async () => ({
          operationId: currentStrategyGovernedContext()?.operationId,
        })),
      } as unknown as MeriService;
      const contextPlane = {
        compile: jest.fn().mockResolvedValue(governed(operationId)),
      };
      const service = createGovernedStrategyMeriService(
        raw,
        contextPlane as never,
        { withTenant: jest.fn() } as never,
      );

      const result = await service.draftExecutionDocument('tenant-1', bearer(), {
        kind,
        clientId: CLIENT,
        strategyType: 'appropriations',
        goal: 'Protect the request',
        node: {
          id: NODE,
          kind: 'action',
          subject: 'deliverable',
          title: 'Draft the artifact',
          note: null,
          startsOn: '2027-01-01',
          endsOn: null,
        },
        grounding: {} as never,
        stewardFacts: [],
        stewardHealth: {
          status: 'ok',
          missingRequired: [],
          openMaterialConflicts: [],
        },
      });

      expect(result).toEqual({ operationId });
      expect(contextPlane.compile).toHaveBeenCalledWith(
        expect.objectContaining({
          clerkUserId: 'clerk-user-1',
          artifactKind: kind,
          mode: 'document',
          nodeId: NODE,
        }),
      );
    },
  );

  test('document context failure or unresolvable bearer uses the deterministic placeholder without provider reasoning', async () => {
    const raw = {
      draft: jest.fn(),
      assistant: jest.fn(),
      draftExecutionDocument: jest.fn(),
    } as unknown as MeriService;
    const contextPlane = {
      compile: jest.fn().mockRejectedValue(new Error('context_plane_unavailable')),
    };
    // Same in-place-mutation caveat as above.
    const originalDocument = raw.draftExecutionDocument;
    const service = createGovernedStrategyMeriService(
      raw,
      contextPlane as never,
      { withTenant: jest.fn() } as never,
    );
    const input = {
      kind: 'workspace_draft' as const,
      clientId: CLIENT,
      strategyType: 'appropriations',
      goal: null,
      node: {
        id: NODE,
        kind: 'action',
        subject: 'deliverable',
        title: 'Draft',
        note: null,
        startsOn: null,
        endsOn: null,
      },
      grounding: {} as never,
      stewardFacts: [],
      stewardHealth: {
        status: 'ok' as const,
        missingRequired: [],
        openMaterialConflicts: [],
      },
    };

    await expect(service.draftExecutionDocument('tenant-1', bearer(), input)).resolves.toBeNull();
    await expect(service.draftExecutionDocument('tenant-1', 'not-a-jwt', input)).resolves.toBeNull();
    expect(originalDocument).not.toHaveBeenCalled();
  });
});
