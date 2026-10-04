import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
jest.mock('./meri-case12-capture-authority.js',()=>({assertMeriCase12BindingInTx:jest.fn()}));
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { ContextPlaneGatewayService } from '../context/context-plane-gateway.service.js';
import { ContextResolverService } from '../context/context-resolver.service.js';
import { RetrievalV2Service } from '../retrieval/retrieval-v2.service.js';
import { RetrievalPlannerV2Service } from '../retrieval/retrieval-planner-v2.service.js';
import { SemanticDataCatalogService } from '../retrieval/data-catalog/semantic-data-catalog.service.js';
import { CorePrismaRetrievalAdapter } from '../retrieval/adapters/core-prisma-retrieval.adapter.js';
import type { RetrievalSourceAdapter } from '../retrieval/retrieval-source.adapter.js';
import type { RetrievalSourceResult } from '../retrieval/retrieval-v2.types.js';
import { MERI_FIXTURE_SEMANTIC_INSTANT, MERI_FIXTURE_SEMANTIC_ZONE, type MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import { searchCapiroData } from './meri-data-search.helpers.js';

// Keep the actual product seam, gateway enforcement/audit, scope resolver,
// planner, retrieval service and mail authorization adapter. Only packet
// construction/storage and unrelated entity/bootstrap services are substituted.
jest.mock('../context/context-compiler.service.js', () => ({ ContextCompilerService: class {} }));
jest.mock('../context/context-packet-v2.service.js', () => ({ ContextPacketV2Service: class {} }));
jest.mock('../context/context-plane-audit.service.js', () => ({
  ContextPlaneAuditService: class {},
}));
jest.mock('../context/meetings-context-plane.runtime.js', () => ({
  MeetingsContextPlaneRuntime: class {},
}));
jest.mock('../knowledge/entities/universal-entity-resolution-orchestrator.service.js', () => ({
  UniversalEntityResolutionOrchestratorService: class {},
}));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

let forbiddenFetch: jest.SpyInstance;
beforeEach(()=>{jest.mocked(assertMeriCase12BindingInTx).mockReset().mockResolvedValue({currentVerifySha256:'a'.repeat(64)} as never); forbiddenFetch=jest.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden in Case12 context-plane tests'));});
afterEach(()=>{expect(forbiddenFetch).not.toHaveBeenCalled();forbiddenFetch.mockRestore();});

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const clientId = '11111111-1111-4111-8111-111111111111';
const memoryItemId = '22222222-2222-4222-8222-222222222222';
const evidence = 'A complete source sentence. '.repeat(1000);

function page(domain: RetrievalSourceResult['domain']): RetrievalSourceResult {
  return {
    domain,
    records: [
      {
        domain,
        recordId: 'source-1',
        payload: { text: evidence },
        provenance: { source: 'canonical-source', recordId: 'source-1' },
      },
    ],
    total: 2,
    returned: 1,
    hasMore: true,
    nextCursor: 'source-next',
    truncated: true,
    sourceStatus: 'healthy',
    recordsEvaluated: 2,
    requestedEntityCount: 1,
    searchedEntityCount: 1,
    pagesRead: 1,
    paginationComplete: false,
    coverageComplete: false,
    stopReason: 'page_boundary_reached',
  };
}

function harness(adapters: RetrievalSourceAdapter[]) {
  const retrieval = new RetrievalV2Service(
    new RetrievalPlannerV2Service(new SemanticDataCatalogService()),
    adapters,
  );
  const retrieve = jest.spyOn(retrieval, 'retrieve');
  const entityResolver = { resolveAcrossSources: jest.fn() };
  const resolver = new ContextResolverService(entityResolver as never, retrieval);
  const packets = { compile: jest.fn().mockResolvedValue({ version: 2, packetId: 'packet-1' }) };
  const compiler = { modeFor: jest.fn().mockResolvedValue('enforce') };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const gateway = new ContextPlaneGatewayService(
    resolver,
    packets as never,
    compiler as never,
    audit as never,
  );
  const requestContext = jest.spyOn(gateway, 'requestContext');
  const capturePrisma = {withTenantUser: jest.fn(async (_tenant: string, _actor: string, fn: (tx: object)=>unknown)=>fn({}))};
  const service = new MeriContextPlaneService(capturePrisma as never, gateway);
  const security = jest
    .spyOn(service, 'securityEnvelope')
    .mockResolvedValue({ authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [] });
  return {
    service,
    capturePrisma,
    retrieval,
    retrieve,
    gateway,
    requestContext,
    security,
    entityResolver,
    packets,
    compiler,
    audit,
  };
}

describe('qualified search_memory compiler clock', () => {
  function capture(caseId: '01' | '12' | '14' = '01') {
    const issuedAt = Date.now();
    const policy = {
      version: 1, kind: 'server_readonly_acceptance_capture', policyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      turnId: 'actual-user-turn', caseId, captureRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      fixtureVersion: 'meri-live-v1-2026-09-26.1', tenantId: ctx.tenantId, actorUserId: ctx.userId,
      clientId, conversationId: 'conversation-1', issuedAt, expiresAt: issuedAt + 60_000,
      semanticClock: { version: 1, kind: 'qualified_original_fixture_semantic_clock',
        instant: MERI_FIXTURE_SEMANTIC_INSTANT, timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
        caseId, captureRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        observedAt: issuedAt, currentVerifySha256: 'a'.repeat(64) },
    } as MeriServerReadonlyCapturePolicy;
    if(caseId==='12'){policy.resetReceiptId=null;policy.seedReceiptId=null;policy.case12Setup={setupRunId:'99999999-9999-4999-8999-999999999999',fixtureInstanceId:'88888888-8888-4888-8888-888888888888',setupPlanSha256:'a'.repeat(64),setupClaimSha256:'b'.repeat(64),setupLedgerSha256:'c'.repeat(64)};}
    return { policy, tool: 'search_memory' as const };
  }
  const toolInput = { query: 'approved constraints', domains: ['institutional_knowledge'],
    clientId, queryClass: 'lookup', pageSize: 1, memoryItemId,
    cursors: { institutional_knowledge: 'approved-page' },
    windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-09-10T00:00:00Z' };
  function fixture() {
    const source = { key: 'knowledge-plane-temporal-graph', domains: ['institutional_knowledge'],
      retrieve: jest.fn().mockResolvedValue(page('institutional_knowledge')) } satisfies RetrievalSourceAdapter;
    const h = harness([source]);
    const packet = { version: 2, packetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', persisted: true,
      clockUse: { instant: MERI_FIXTURE_SEMANTIC_INSTANT, timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
        eligibilityAt: new Date().toISOString(), scoring: 'used' } };
    h.packets.compile.mockResolvedValue(packet);
    return { ...h, source, packet };
  }

  it.each(['01', '12', '14'] as const)('uses the qualified instant and retains actual compiler metadata for case %s', async caseId => {
    const h = fixture();
    const bound = capture(caseId);
    const result = await searchCapiroData(ctx, toolInput, h.service, bound);
    expect(h.packets.compile).toHaveBeenCalledWith(expect.objectContaining({
      now: new Date(MERI_FIXTURE_SEMANTIC_INSTANT), semanticClock: bound.policy.semanticClock,
      traceId: bound.policy.traceId,
      ref: expect.objectContaining({ tool: 'search_memory', capturePolicyId: bound.policy.policyId,
        captureRequestId: bound.policy.requestId, captureTurnId: bound.policy.turnId }),
    }), expect.anything(), expect.anything());
    expect(h.requestContext).toHaveBeenCalledWith(expect.objectContaining({ requestId: bound.policy.requestId }));
    expect(h.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      memoryItemId, cursors: toolInput.cursors,
      windowStart: new Date(toolInput.windowStart), windowEnd: new Date(toolInput.windowEnd),
    }));
    expect(h.retrieve.mock.calls[0]![0]).not.toHaveProperty('observedThrough');
    expect(result.contextPacket).toEqual({ packetId: h.packet.packetId, persisted: true,
      clockUse: h.packet.clockUse });
    expect(result.contextPacket!.clockUse).not.toBe(h.packet.clockUse);
    expect(result.records[0]!.payload.text).toBe(evidence);
    expect(assertMeriCase12BindingInTx).toHaveBeenCalledTimes(caseId==='12'?2:0);
    if(caseId==='12')expect(h.capturePrisma.withTenantUser).toHaveBeenCalledTimes(2);
  });

  it('Case12 native owner denial stops before gateway or retrieval',async()=>{
    const h=fixture();jest.mocked(assertMeriCase12BindingInTx).mockRejectedValueOnce(new Error('CASE12_CURRENT_DENIED'));
    await expect(searchCapiroData(ctx,toolInput,h.service,capture('12'))).rejects.toThrow('CASE12_CURRENT_DENIED');
    expect(h.security).not.toHaveBeenCalled();expect(h.requestContext).not.toHaveBeenCalled();expect(h.retrieve).not.toHaveBeenCalled();
  });
  it('Case12 owner drift after actual gateway rejects returned packet',async()=>{
    const h=fixture();jest.mocked(assertMeriCase12BindingInTx).mockResolvedValueOnce({currentVerifySha256:'a'.repeat(64)} as never).mockRejectedValueOnce(new Error('CASE12_CHANGED'));
    await expect(searchCapiroData(ctx,toolInput,h.service,capture('12'))).rejects.toThrow('CASE12_CHANGED');
    expect(h.requestContext).toHaveBeenCalledTimes(1);expect(h.retrieve).toHaveBeenCalledTimes(1);expect(h.packets.compile).toHaveBeenCalledTimes(1);
  });
  it('preserves an actually returned V1/not_run observation', async () => {
    const h = fixture();
    h.compiler.modeFor.mockResolvedValue('off');
    h.packet.version = 1;
    h.packet.clockUse.scoring = 'not_run';
    const result = await searchCapiroData(ctx, toolInput, h.service, capture());
    expect(result.contextPacket!.clockUse!.scoring).toBe('not_run');
  });

  it('does not infer successful compiler use from the policy', async () => {
    for (const change of [
      { clockUse: undefined }, { persisted: false }, { packetId: null },
      { clockUse: { ...fixture().packet.clockUse, instant: '2000-01-01T00:00:00.000Z' } },
      { clockUse: { ...fixture().packet.clockUse, eligibilityAt: 'unknown' } },
      { clockUse: { ...fixture().packet.clockUse, scoring: 'invented' } },
    ]) {
      const h = fixture();
      h.packets.compile.mockResolvedValue({ ...h.packet, ...change });
      await expect(searchCapiroData(ctx, toolInput, h.service, capture())).rejects.toThrow('tool_compiler_unproved');
    }
  });

  it('rejects missing, arbitrary, expired, budget-only and wrong-actor clock bindings before retrieval', async () => {
    const original = capture();
    for (const change of [
      { semanticClock: undefined }, { tenantId: 'other-tenant' }, { actorUserId: 'other-user' },
      { turnId: null }, { expiresAt: Date.now() - 1 }, { fixtureVersion: 'unqualified' },
      { clientId: null }, { clientId: '' }, { clientId: ' ' },
      { syntheticReadBudget: {} }, { caseId: '20' },
      { semanticClock: { ...original.policy.semanticClock, instant: '2020-01-01T00:00:00.000Z' } },
    ]) {
      const h = fixture();
      await expect(searchCapiroData(ctx, toolInput, h.service, { ...original,
        policy: { ...original.policy, ...change } as MeriServerReadonlyCapturePolicy,
      })).rejects.toThrow('semantic_clock');
      expect(h.retrieve).not.toHaveBeenCalled();
    }
  });

  it.each(['01', '12', '14'] as const)('rejects a missing tool client before retrieval for case %s', async caseId => {
    const h = fixture();
    await expect(searchCapiroData(ctx, { ...toolInput, clientId: undefined }, h.service, capture(caseId)))
      .rejects.toThrow('meri_fixture_semantic_clock_tool_binding_mismatch');
    expect(h.security).not.toHaveBeenCalled();
    expect(h.requestContext).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it.each(['01', '12', '14'] as const)('rejects another already-authorized client before retrieval for case %s', async caseId => {
    const h = fixture();
    const otherClientId = '33333333-3333-4333-8333-333333333333';
    h.security.mockResolvedValue({ authorizedClientIds: [clientId, otherClientId], authorizedMailboxConnectionIds: [] });
    await expect(searchCapiroData(ctx, { ...toolInput, clientId: otherClientId }, h.service, capture(caseId)))
      .rejects.toThrow('meri_fixture_semantic_clock_tool_binding_mismatch');
    expect(h.security).not.toHaveBeenCalled();
    expect(h.requestContext).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it('keeps arbitrary tool-input dates out of compiler authority and ordinary output unchanged', async () => {
    const h = fixture();
    const result = await searchCapiroData(ctx, { ...toolInput,
      semanticClock: capture().policy.semanticClock, now: MERI_FIXTURE_SEMANTIC_INSTANT,
      compilerCapture: capture() }, h.service);
    const request = h.packets.compile.mock.calls[0]![0];
    expect(request).not.toHaveProperty('semanticClock');
    expect(request).not.toHaveProperty('now');
    expect(result).not.toHaveProperty('contextPacket');
  });

  it('preserves current client authorization under the qualified clock', async () => {
    const h = fixture();
    h.security.mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] });
    await expect(searchCapiroData(ctx, toolInput, h.service, capture())).rejects.toBeInstanceOf(NotFoundException);
    expect(h.retrieve).not.toHaveBeenCalled();
  });
});

describe('Meri tool reads through the adopted Context Plane gateway', () => {
  it('preserves Monday board selectors and continuations through enforced, audited retrieval', async () => {
    const source = {
      key: 'monday-managed-mcp',
      domains: ['monday'],
      retrieve: jest.fn().mockResolvedValue(page('monday')),
    } satisfies RetrievalSourceAdapter;
    const h = harness([source]);
    const deadlineAt = Date.now() + 30_000;
    const result = await h.service.searchToolData(ctx, {
      clientId,
      queryClass: 'lookup',
      requestedDomains: ['monday'],
      mondayBoardContext: 'board:42',
      cursors: { monday: 'source-next' },
      pageSize: 1,
      requireComplete: false,
      deadlineAt,
    });
    expect(h.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'meri.chat',
        resolverRequest: expect.objectContaining({ clientId, subjectScope: 'client' }),
      }),
    );
    expect(h.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientIds: [clientId],
        }),
        mondayBoardContext: 'board:42',
        cursors: { monday: 'source-next' },
        pageSize: 1,
        requireComplete: false,
        deadlineAt,
      }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ allowed: true }),
      }),
    );
    expect(result.records[0]?.payload).toEqual({ text: evidence });
    expect(result.coverage.sources[0]).toMatchObject({ nextCursor: 'source-next', hasMore: true });
    h.security.mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] });
    await expect(
      h.service.searchToolData(ctx, {
        clientId,
        queryClass: 'lookup',
        requestedDomains: ['monday'],
        cursors: { monday: 'source-next' },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(source.retrieve).toHaveBeenCalledTimes(1);
  });

  it('preserves exact memory narrowing, dates, cursors and full source content after packet enforcement', async () => {
    const source = {
      key: 'knowledge-plane-temporal-graph',
      domains: ['institutional_knowledge'],
      retrieve: jest.fn().mockResolvedValue(page('institutional_knowledge')),
    } satisfies RetrievalSourceAdapter;
    const h = harness([source]);
    const result = await h.service.searchToolData(ctx, {
      query: 'Approved constraints',
      queryClass: 'lookup',
      requestedDomains: ['institutional_knowledge'],
      clientId,
      memoryItemId,
      pageSize: 1,
      cursors: { institutional_knowledge: 'approved-page' },
      windowStart: new Date('2026-09-01T00:00:00Z'),
      windowEnd: new Date('2026-09-10T00:00:00Z'),
      requireComplete: false,
    });
    expect(h.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'meri.chat',
        resolverRequest: expect.objectContaining({
          surface: 'chat',
          subjectScope: 'client',
          clientId,
        }),
        contextRequest: expect.objectContaining({
          surface: 'chat',
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
        }),
      }),
    );
    expect(h.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryItemId,
        query: 'Approved constraints',
        queryClass: 'lookup',
        pageSize: 1,
        requireComplete: false,
        windowStart: new Date('2026-09-01T00:00:00Z'),
        windowEnd: new Date('2026-09-10T00:00:00Z'),
        cursors: { institutional_knowledge: 'approved-page' },
        caller: expect.objectContaining({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientIds: [clientId],
          authorizedClientIds: [clientId],
          authorizedMailboxConnectionIds: [],
        }),
      }),
    );
    expect(result.records[0]!.payload.text).toBe(evidence);
    expect(result.coverage.sources[0]).toMatchObject({
      nextCursor: 'source-next',
      coverageComplete: false,
    });
    expect(h.packets.compile).toHaveBeenCalledTimes(1);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ allowed: true, reason: 'governed_packet' }),
        coverage: expect.objectContaining({ ran: true, complete: false }),
      }),
    );
    expect(h.entityResolver.resolveAcrossSources).not.toHaveBeenCalled();
  });

  it('keeps hearing filters and one-chunk continuation without searching an invented task string', async () => {
    const source = {
      key: 'hearings',
      domains: ['hearings'],
      retrieve: jest.fn().mockResolvedValue(page('hearings')),
    } satisfies RetrievalSourceAdapter;
    const h = harness([source]);
    const hearingFilters = {
      hearingId: 'hearing-1',
      chamber: 'House',
      committeeName: 'Appropriations',
    };
    await h.service.searchToolData(ctx, {
      queryClass: 'lookup',
      requestedDomains: ['hearings'],
      query: '',
      hearingFilters,
      pageSize: 1,
      cursors: { hearings: 'hearing-page' },
    });
    expect(h.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        query: undefined,
        hearingFilters,
        pageSize: 1,
        cursors: { hearings: 'hearing-page' },
      }),
    );
    expect(h.requestContext.mock.calls[0]![0].resolverRequest.subjectScope).toBe('general');
    expect(h.entityResolver.resolveAcrossSources).not.toHaveBeenCalled();
  });

  it('denies an empty mailbox scope before mail access while preserving other authorized source results', async () => {
    const tx = {
      client: { findMany: jest.fn().mockResolvedValue([{ id: clientId }]) },
      integrationConnection: { findMany: jest.fn() },
      mailMessage: { findMany: jest.fn(), count: jest.fn() },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenant: string, run: (db: typeof tx) => unknown) => run(tx)),
    };
    const mail = new CorePrismaRetrievalAdapter(prisma as never);
    const strategy = {
      key: 'strategies-work',
      domains: ['strategies_work'],
      retrieve: jest.fn().mockResolvedValue(page('strategies_work')),
    } satisfies RetrievalSourceAdapter;
    const h = harness([mail, strategy]);
    const result = await h.service.searchToolData(ctx, {
      query: 'status',
      queryClass: 'lookup',
      requestedDomains: ['mail', 'strategies_work'],
    });
    expect(h.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: expect.objectContaining({ authorizedMailboxConnectionIds: [] }),
      }),
    );
    expect(tx.integrationConnection.findMany).not.toHaveBeenCalled();
    expect(tx.mailMessage.findMany).not.toHaveBeenCalled();
    expect(tx.mailMessage.count).not.toHaveBeenCalled();
    expect(result.records.map((record) => record.domain)).toEqual(['strategies_work']);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.sources.find((source) => source.domain === 'mail')).toMatchObject({
      sourceStatus: 'unauthorized',
      stopReason: 'authorized_mailbox_scope_empty',
      returned: 0,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        coverage: expect.objectContaining({
          sourceStatuses: expect.objectContaining({ mail: 'unauthorized' }),
        }),
      }),
    );
  });

  it('rechecks the server grant before a continuation and blocks a revoked client before gateway retrieval', async () => {
    const source = {
      key: 'hearings',
      domains: ['hearings'],
      retrieve: jest.fn().mockResolvedValue(page('hearings')),
    } satisfies RetrievalSourceAdapter;
    const h = harness([source]);
    const input = {
      clientId,
      queryClass: 'lookup' as const,
      requestedDomains: ['hearings'] as const,
      pageSize: 1,
    };
    await h.service.searchToolData(ctx, input);
    h.security.mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] });
    await expect(
      h.service.searchToolData(ctx, { ...input, cursors: { hearings: 'source-next' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.security).toHaveBeenCalledTimes(2);
    expect(h.requestContext).toHaveBeenCalledTimes(1);
    expect(source.retrieve).toHaveBeenCalledTimes(1);
  });

  it('propagates enforced packet rejection instead of falling back to retrieved records', async () => {
    const source = {
      key: 'hearings',
      domains: ['hearings'],
      retrieve: jest.fn().mockResolvedValue(page('hearings')),
    } satisfies RetrievalSourceAdapter;
    const h = harness([source]);
    h.packets.compile.mockResolvedValue({ version: 1 });
    await expect(
      h.service.searchToolData(ctx, { queryClass: 'lookup', requestedDomains: ['hearings'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ allowed: false, reason: 'governed_packet_required' }),
      }),
    );
  });

  it.each([{ kind: 'migration_exception' }, { kind: 'governed_packet', context: {} }])(
    'fails closed if the governed operation did not retrieve (%j)',
    async (result) => {
      const h = harness([]);
      h.requestContext.mockResolvedValue(result as never);
      await expect(
        h.service.searchToolData(ctx, { queryClass: 'lookup', requestedDomains: ['hearings'] }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(h.retrieve).not.toHaveBeenCalled();
    },
  );
});
