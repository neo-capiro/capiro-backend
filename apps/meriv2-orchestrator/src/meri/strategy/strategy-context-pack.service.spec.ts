import type { MeriContext, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import { StrategyContextPackService } from './strategy-context-pack.service.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const CTX = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  clerkUserId: 'user_test',
  role: 'standard_user',
  contextPacket: {
    packetId: '44444444-4444-4444-8444-444444444444',
    persisted: true,
    surface: 'strategy',
    clientId: CLIENT,
    items: [],
    exclusions: [],
    unauthorizedCount: 0,
    degraded: false,
  },
} as MeriContext;

function governed(overrides: Partial<MeriGovernedTurnContext> = {}): MeriGovernedTurnContext {
  return {
    version: 1,
    operationId: 'strategies.generate',
    prompt:
      '<capiro_strategy_context_plane>governed client history</capiro_strategy_context_plane>',
    contextPacket: {
      packetId: '44444444-4444-4444-8444-444444444444',
      persisted: true,
      surface: 'strategy',
      clientId: CLIENT,
      items: [
        {
          id: 'memory-1',
          label: 'Client compass',
          type: 'client-compass',
          scope: 'client',
          authority: 'human-authored',
          selection: 'automatic',
        },
      ],
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
        requiredDomains: ['clients', 'strategies_work', 'mail'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: ['clients', 'strategies_work', 'mail'],
        searchedDomains: ['clients', 'strategies_work', 'mail'],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 8,
        recordsReturned: 5,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
    ...overrides,
  };
}

describe('StrategyContextPackService — governed Context Plane projection', () => {
  const service = new StrategyContextPackService();

  test('projects the already-compiled prompt without running a second retrieval path', async () => {
    const input = governed();
    const pack = await runWithGovernedMeriContext(input, () =>
      service.compile({ ctx: CTX, clientId: CLIENT, query: 'win the plus-up', slim: false }),
    );

    expect(pack.text).toBe(input.prompt);
    expect(pack.provenance.sections).toEqual([
      { name: 'ContextPacket V2', count: 1 },
      { name: 'Shared Retrieval V2', count: 5 },
    ]);
    expect(pack.health).toEqual({
      status: 'ok',
      missingRequired: [],
      omittedOptional: [],
    });
  });

  test.each(['workspace.generate', 'outreach.generate'] as const)(
    'accepts destination-owned %s context for Strategy execution drafting',
    async (operationId) => {
      const packetSurface = operationId === 'workspace.generate' ? 'workspace-gen' : 'outreach';
      const input = governed({
        operationId,
        contextPacket: { ...governed().contextPacket, surface: packetSurface },
      });
      const ctx = { ...CTX, contextPacket: input.contextPacket } as MeriContext;
      const pack = await runWithGovernedMeriContext(input, () =>
        service.compile({ ctx, clientId: CLIENT, query: 'draft artifact', slim: false }),
      );
      expect(pack.text).toContain('governed client history');
    },
  );

  test('marks required shared domains missing instead of treating zero coverage as healthy', async () => {
    const input = governed({
      retrieval: {
        ...governed().retrieval,
        coverage: {
          ...governed().retrieval.coverage,
          complete: false,
          searchedDomains: ['mail'],
          missingDomains: ['clients', 'strategies_work'],
          recordsReturned: 0,
          paginationComplete: false,
          stopReason: 'required_sources_unavailable',
        },
      },
    });
    const pack = await runWithGovernedMeriContext(input, () =>
      service.compile({ ctx: CTX, clientId: CLIENT, query: 'goal', slim: false }),
    );

    expect(pack.health.status).toBe('degraded');
    expect(pack.health.missingRequired).toEqual(['clients', 'strategies_work']);
    expect(pack.provenance.omitted).toEqual(
      expect.arrayContaining(['Retrieval domain: clients', 'Retrieval domain: strategies_work']),
    );
  });

  test('records optional source gaps without reclassifying them as required', async () => {
    const input = governed({
      retrieval: {
        ...governed().retrieval,
        coverage: {
          ...governed().retrieval.coverage,
          complete: false,
          missingDomains: ['mail'],
          stopReason: 'mail_unavailable',
        },
      },
    });
    const pack = await runWithGovernedMeriContext(input, () =>
      service.compile({ ctx: CTX, clientId: CLIENT, query: 'goal', slim: true }),
    );
    expect(pack.health.status).toBe('degraded');
    expect(pack.health.missingRequired).toEqual([]);
    expect(pack.health.omittedOptional).toEqual(['mail']);
  });

  test('fails closed when called without the governed runtime', async () => {
    await expect(
      service.compile({ ctx: CTX, clientId: CLIENT, query: 'goal', slim: false }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('fails closed on packet/client drift', async () => {
    const input = governed({
      contextPacket: {
        ...governed().contextPacket,
        clientId: '55555555-5555-4555-8555-555555555555',
      },
    });
    await expect(
      runWithGovernedMeriContext(input, () =>
        service.compile({ ctx: CTX, clientId: CLIENT, query: 'goal', slim: false }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
