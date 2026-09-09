jest.mock('../context/context-plane-gateway.service.js', () => ({
  ContextPlaneGatewayService: class ContextPlaneGatewayService {},
}));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class PrismaService {} }));
jest.mock('../knowledge/entities/universal-entity-resolution-orchestrator.service.js', () => ({
  UniversalEntityResolutionOrchestratorService: class UniversalEntityResolutionOrchestratorService {},
}));
jest.mock('../retrieval/retrieval-v2.service.js', () => ({
  RetrievalV2Service: class RetrievalV2Service {},
}));

import type { TenantContext } from '@capiro/shared';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { MeriContextPlaneRuntimeService, currentMeriGovernedRuntime } from './meri-context-plane-runtime.js';
import { captureMeriTurnScope } from './meri-turn-scope.js';
import { ContextResolverService } from '../context/context-resolver.service.js';
import type { ContextResolutionRequest } from '../context/context-resolver.types.js';
import { StrategyWorkRetrievalAdapter } from '../retrieval/adapters/strategy-work-retrieval.adapter.js';
import { buildCoverageManifest } from '../retrieval/coverage-manifest.js';
import type {
  RetrievalRequest,
  SemanticDatasetDescriptor,
} from '../retrieval/retrieval-v2.types.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as TenantContext;
const clients = ['client-a', 'client-b'];

function setup(archivedClientIds: string[] = []) {
  const sourceRow = {
    recordKey: 'strategy:plan-1',
    recordId: 'plan-1',
    recordKind: 'strategy',
    clientId: 'client-a',
    updatedAt: new Date(),
    payload: { title: 'Secure committee language', goal: 'Obtain report language' },
  };
  const sqlRead = jest.fn(async (sql: { values: unknown[] }) => {
    // Faithful substring behavior: this work has no client name or chat request in its body.
    const filter = sql.values.find((value) => typeof value === 'string' && value.startsWith('%'));
    if (
      filter &&
      !JSON.stringify(sourceRow.payload)
        .toLowerCase()
        .includes(String(filter).slice(1, -1).toLowerCase())
    )
      return [];
    return [sourceRow];
  });
  const tx = {
    clioConversation: { findFirst: jest.fn().mockResolvedValue({ clientId: 'client-a', client: { id: 'client-a', name: 'Acme Defense' } }) },
    client: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Acme Defense' }),
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        clients
          .filter((id) => !where.id || where.id.in.includes(id))
          .map((id) => ({ id, status: archivedClientIds.includes(id) ? 'archived' : 'active' })),
      ),
    },
    integrationConnection: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: sqlRead,
  };
  const prisma = {
    withTenant: jest.fn((_tenant, fn) => fn(tx)),
    withTenantUser: jest.fn((_tenant, _user, fn) => fn(tx)),
  };
  const strategy = new StrategyWorkRetrievalAdapter(prisma as never);
  const retrieve = jest.fn(async (request: RetrievalRequest) => {
    const result = await strategy.retrieve(
      { domain: 'strategies_work' } as SemanticDatasetDescriptor,
      request,
    );
    return {
      records: result.records,
      coverage: buildCoverageManifest(request.requestedDomains, [result]),
      observability: {},
    };
  });
  const resolver = new ContextResolverService({} as never, { retrieve } as never);
  const gateway = {
    requestContext: jest.fn(
      async ({ resolverRequest }: { resolverRequest: ContextResolutionRequest }) => ({
        kind: 'governed_packet',
        context: await resolver.resolveAndRetrieve(resolverRequest),
        packet: { persisted: true, packetId: 'packet-1', items: [], exclusions: [], rendered: [] },
      }),
    ),
  };
  const meri = new MeriContextPlaneService(prisma as never, gateway as never);
  const runtime = new MeriContextPlaneRuntimeService(prisma as never, meri);
  return { meri, runtime, gateway, resolver, retrieve, sqlRead, tx };
}

describe('Meri strategy context from chat scope through source adapter', () => {
  it('reports a healthy but unfinished source page as partial in both model and UI coverage', async () => {
    const { meri, sqlRead } = setup();
    sqlRead.mockResolvedValue(Array.from({ length: 51 }, (_, index) => ({
      recordKey: `strategy:plan-${index}`, recordId: `plan-${index}`, recordKind: 'strategy',
      clientId: 'client-a', updatedAt: new Date('2026-09-01'),
      payload: { title: 'Secure committee language', goal: 'Obtain report language' },
    })));
    const result = await meri.resolveChat(ctx, { conversationId: 'conversation-1', task: 'Review our strategies' });
    expect(result.retrieval.coverage.sourceHealth).toContainEqual(expect.objectContaining({
      source: 'strategies_work', status: 'partial',
    }));
    expect(result.retrieval.coverage.paginationComplete).toBe(false);
    expect(result.prompt).toContain('paginationComplete=false');
    expect(result.prompt).toContain('"source":"strategies_work","status":"partial"');
  });

  it('feeds meeting preparation the same client strategy even without the word strategy in the request', async () => {
    const { meri, retrieve } = setup();
    const result = await meri.resolveChat(ctx, { conversationId: 'conversation-1', task: 'Prepare a meeting briefing for HASC staff' });
    expect(retrieve.mock.calls[0]![0]).toMatchObject({
      queryClass: 'lookup', caller: { clientIds: ['client-a'] },
      requestedDomains: expect.arrayContaining(['clients', 'contacts', 'meetings', 'strategies_work']),
    });
    expect(result.prompt).toContain('Secure committee language');
    // This fixture executes only strategies. Coverage must disclose the missing
    // client/meeting sources in the model prompt, rather than imply completeness.
    expect(result.prompt).toContain(`sourceHealth=${JSON.stringify(result.retrieval.coverage.sourceHealth)}`);
    expect(result.prompt).toContain(`unavailableSources=${JSON.stringify(result.retrieval.coverage.unavailableSources)}`);
    expect(result.retrieval.coverage.complete).toBe(false);
    expect(result.prompt).toContain('Missing timestamps mean freshness is unknown');
  });

  it('retrieves a selected-client strategy even when neither its body nor title names the client or request', async () => {
    const { meri, gateway, retrieve, sqlRead } = setup();
    const result = await meri.resolveChat(ctx, {
      conversationId: 'conversation-1',
      task: 'Review our strategies and unresolved work',
    });
    expect(gateway.requestContext.mock.calls[0]![0].resolverRequest.retrieval?.query).toBeNull();
    expect(retrieve.mock.calls[0]![0].caller).toMatchObject({
      clientIds: ['client-a'],
      authorizedClientIds: clients,
    });
    expect(retrieve.mock.calls[0]![0].query).toBeUndefined();
    expect(sqlRead.mock.calls[0]![0].values).not.toContain(
      '%Review our strategies and unresolved work%',
    );
    expect(result.prompt).toContain('Secure committee language');
    expect(result.retrieval.coverage.searchedDomains).toContain('strategies_work');
  });

  it.each(['Review strategies across our clients', 'Compare all clients'])('expands portfolio scope into explicit authorized client IDs: %s', async (task) => {
    const { meri, retrieve } = setup();
    const result = await meri.resolveChat(ctx, {
      conversationId: 'conversation-1',
      task,
    });
    expect(result.retrieval.plan.subjectScope).toBe('portfolio');
    expect(captureMeriTurnScope({ clientId: 'client-a' }, result.retrieval)).toEqual({
      kind: 'portfolio', clientId: null, clientName: null, targetHint: null,
    });
    expect(retrieve.mock.calls[0]![0]).toMatchObject({
      queryClass: 'portfolio_scan',
      requireComplete: true,
      caller: { clientIds: clients, authorizedClientIds: clients },
    });
    expect(retrieve.mock.calls[0]![0].query).toBeUndefined();
    expect(result.prompt).toContain('Secure committee language');
  });

  it('passes recent-change bounds through the resolver and applies a half-open update window to strategy SQL', async () => {
    const { meri, retrieve, sqlRead } = setup();
    await meri.resolveChat(ctx, {
      conversationId: 'conversation-1',
      task: 'What changed in the last 7 days?',
    });
    const request = retrieve.mock.calls[0]![0];
    const sql = sqlRead.mock.calls[0]![0] as unknown as { sql: string; values: unknown[] };
    expect(request.query).toBeUndefined();
    expect(request.observedThrough).toBeUndefined();
    expect(request.windowStart).toBeInstanceOf(Date);
    expect(request.windowEnd).toBeInstanceOf(Date);
    expect(sql.sql).toContain('combined.updated_at >=');
    expect(sql.sql).toContain('combined.updated_at <');
    expect(sql.values).toContain(request.windowStart);
    expect(sql.values).toContain(request.windowEnd);
  });

  it('returns active portfolio work with an explicit gap for authorized archived clients', async () => {
    const { meri, retrieve, sqlRead } = setup(['client-b']);
    const result = await meri.resolveChat(ctx, {
      conversationId: 'conversation-1',
      task: 'Review strategies across our clients',
    });
    expect(retrieve.mock.calls[0]![0].caller.clientIds).toEqual(clients);
    expect(sqlRead.mock.calls[0]![0].values).not.toContain('client-b');
    expect(result.prompt).toContain('Secure committee language');
    expect(result.retrieval.coverage.complete).toBe(false);
    expect(result.retrieval.coverage.partialDomains).toContain('strategies_work');
    expect(result.retrieval.coverage.sourceHealth).toContainEqual(
      expect.objectContaining({
        source: 'strategies_work',
        detail: 'archived_client_subjects_excluded',
      }),
    );
  });

  it('does not read current strategy tables for an explicitly archived client', async () => {
    const { meri, sqlRead } = setup(['client-a']);
    const result = await meri.resolveChat(ctx, {
      conversationId: 'conversation-1',
      task: 'Review our strategies',
    });
    expect(sqlRead).not.toHaveBeenCalled();
    expect(result.retrieval.coverage.complete).toBe(false);
    expect(result.retrieval.coverage.missingDomains).toContain('strategies_work');
  });

  it('preserves legacy task fallback when other context consumers omit a query directive', async () => {
    const { resolver } = setup();
    const result = await resolver.resolve({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      surface: 'chat',
      task: 'Find a specific phrase',
      securityScope: { authorizedClientIds: clients },
      subjectScope: 'client',
      clientId: 'client-a',
      retrieval: { queryClass: 'lookup', requestedDomains: ['strategies_work'] },
    });
    expect(result.retrievalRequest?.query).toBe('Find a specific phrase');
  });

  it('retains explicitly supplied text filters instead of broadening requested searches', async () => {
    const { resolver } = setup();
    const result = await resolver.resolve({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      surface: 'chat',
      task: 'Review strategies',
      securityScope: { authorizedClientIds: clients },
      subjectScope: 'client',
      clientId: 'client-a',
      retrieval: {
        queryClass: 'lookup',
        requestedDomains: ['strategies_work'],
        query: 'committee',
      },
    });
    expect(result.retrievalRequest?.query).toBe('committee');
  });
});


describe('MW-07 scope through the active chat runtime and durable receipt', () => {
  test.each([
    'QA Sep 9: In one sentence, explain authorization versus appropriations.',
    'Extract fields from the attached synthetic QA brief.',
    'Create a Word document and PDF using the synthetic brief.',
    'Reply with exactly READY. Do not use tools or save memory.',
    'Reply with exactly "Research READY". Do not use tools or save memory.',
    'Summarize the attached brief titled "Research QA".',
    'Rewrite this sentence: Research PDF extraction results.',
  ])('preserves client retrieval and saved turn metadata: %s', async (task) => {
    const { runtime, retrieve } = setup();
    const metadata = await runtime.runChatTurn(ctx, {
      conversationId: 'conversation-1', body: task, mode: 'new',
    }, async () => {
      const state = currentMeriGovernedRuntime()!;
      expect(state.activeClient).toEqual({ id: 'client-a', name: 'Acme Defense' });
      expect(state.context.retrieval.plan).toMatchObject({ subjectScope: 'client', targetHint: null });
      return { turnScope: captureMeriTurnScope({ clientId: 'client-a', client: state.activeClient }, state.context.retrieval) };
    });
    expect(retrieve.mock.calls[0]![0].caller).toMatchObject({
      clientIds: ['client-a'], authorizedClientIds: clients,
    });
    // Same existing JSON metadata contract consumed after reload; it contains
    // the original receipt, not text to reclassify using a later picker value.
    expect(JSON.parse(JSON.stringify(metadata))).toEqual({
      turnScope: { kind: 'client', clientId: 'client-a', clientName: 'Acme Defense', targetHint: null },
    });
  });
  test('retains general scope without selecting an acronym entity or a client', async () => {
    const { runtime, tx, gateway } = setup();
    tx.clioConversation.findFirst.mockResolvedValue({ clientId: null, client: null });
    await runtime.runChatTurn(ctx, {
      conversationId: 'conversation-1', body: 'Reply with exactly READY. Do not use tools or save memory.', mode: 'new',
    }, async () => {
      const state = currentMeriGovernedRuntime()!;
      expect(state.activeClient).toBeNull();
      expect(captureMeriTurnScope({ clientId: null }, state.context.retrieval)).toEqual({
        kind: 'general', clientId: null, clientName: null, targetHint: null,
      });
    });
    expect(gateway.requestContext.mock.calls[0]![0].resolverRequest).toMatchObject({ subjectScope: 'general' });
    expect(gateway.requestContext.mock.calls[0]![0].resolverRequest.subject).toBeUndefined();
  });
});
