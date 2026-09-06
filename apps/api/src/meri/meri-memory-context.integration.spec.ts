jest.mock('../context/context-plane-gateway.service.js', () => ({
  ContextPlaneGatewayService: jest.fn(),
}));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: jest.fn() }));
jest.mock('../knowledge/entities/universal-entity-resolution-orchestrator.service.js', () => ({
  UniversalEntityResolutionOrchestratorService: jest.fn(),
}));
jest.mock('../retrieval/retrieval-v2.service.js', () => ({ RetrievalV2Service: jest.fn() }));
jest.mock('../knowledge/graph/temporal-knowledge-graph.service.js', () => ({
  TemporalKnowledgeGraphService: jest.fn(),
}));

import type { TenantContext } from '@capiro/shared';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { ContextResolverService } from '../context/context-resolver.service.js';
import type { ContextResolutionRequest } from '../context/context-resolver.types.js';
import { InstitutionalKnowledgeRetrievalAdapter } from '../retrieval/adapters/institutional-knowledge-retrieval.adapter.js';
import { buildCoverageManifest } from '../retrieval/coverage-manifest.js';
import type {
  RetrievalRequest,
  SemanticDatasetDescriptor,
} from '../retrieval/retrieval-v2.types.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as TenantContext;

function setup() {
  const canonical = {
    id: 'approved-memory',
    tenantId: ctx.tenantId,
    clientId: 'client-a',
    ownerUserId: null,
    key: 'Funding approval',
    type: 'client-compass',
    slug: 'funding-approval',
    sections: [
      {
        key: 'constraint',
        heading: 'Constraint',
        body: 'Ask the client before proposing earmarks.',
      },
    ],
    visibility: 'tenant',
    memoryClass: 'client_steering',
    authority: 'client_approved',
    scope: 'client',
    status: 'active',
    legacyStatus: 'active',
    sourceType: 'user_message',
    sourceId: 'approval-message',
    sourceContentHash: 'source-hash',
    approvedByUserId: 'reviewer-1',
    approvedAt: new Date('2026-08-01'),
    updatedAt: new Date('2026-08-01'),
  };
  const memoryRead = jest.fn(async (sql: { text?: string }) =>
    sql.text?.includes('FROM memory_items mi') ? [canonical] : [],
  );
  const tx = {
    clioConversation: { findFirst: jest.fn().mockResolvedValue({ clientId: 'client-a' }) },
    client: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Acme Defense' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'client-a' }, { id: 'client-b' }]),
    },
    integrationConnection: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    $queryRaw: memoryRead,
  };
  const prisma = {
    withTenant: jest.fn((_tenant, fn) => fn(tx)),
    withTenantUser: jest.fn((_tenant, _user, fn) => fn(tx)),
  };
  const adapter = new InstitutionalKnowledgeRetrievalAdapter(
    {} as never,
    prisma as never,
    {
      // Prove an unavailable embedding provider does not discard approved facts.
      embed: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
    } as never,
  );
  const retrieve = jest.fn(async (request: RetrievalRequest) => {
    const result = await adapter.retrieve(
      { domain: 'institutional_knowledge' } as SemanticDatasetDescriptor,
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
  return { meri, retrieve, canonical, tx };
}

describe('selected-client memory from chat scope through canonical recall', () => {
  it('carries the conversation client through the resolver and returns its approved fact and provenance', async () => {
    const { meri, retrieve } = setup();
    const result = await meri.resolveChat(ctx, {
      conversationId: 'conversation-1',
      task: 'What do you remember about this client?',
    });
    expect(retrieve.mock.calls[0]![0]).toMatchObject({
      queryClass: 'semantic_recall',
      requestedDomains: ['institutional_knowledge'],
      caller: { clientIds: ['client-a'], authorizedClientIds: ['client-a', 'client-b'] },
    });
    expect(result.prompt).toContain('Ask the client before proposing earmarks.');
    expect(result.retrieval.coverage).toMatchObject({
      complete: false,
      partialDomains: ['institutional_knowledge'],
    });
  });

  it('does not recall a revoked fact on the next turn or read a client after its wall grant changes', async () => {
    const { meri, canonical, tx } = setup();
    const input = {
      conversationId: 'conversation-1',
      task: 'What do you remember about this client?',
    };
    await meri.resolveChat(ctx, input);
    canonical.status = 'revoked';
    const revoked = await meri.resolveChat(ctx, input);
    expect(revoked.prompt).not.toContain('Ask the client before proposing earmarks.');
    canonical.status = 'active';
    tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    const denied = await meri.resolveChat(ctx, input);
    expect(denied.prompt).not.toContain('Ask the client before proposing earmarks.');
    expect(denied.retrieval.coverage.missingDomains).toContain('institutional_knowledge');
  });
});
