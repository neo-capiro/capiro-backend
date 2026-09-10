jest.mock('../context/context-plane-gateway.service.js', () => ({ ContextPlaneGatewayService: class ContextPlaneGatewayService {} }));
jest.mock('../knowledge/entities/universal-entity-resolution-orchestrator.service.js', () => ({ UniversalEntityResolutionOrchestratorService: class UniversalEntityResolutionOrchestratorService {} }));
jest.mock('../retrieval/retrieval-v2.service.js', () => ({ RetrievalV2Service: class RetrievalV2Service {} }));

import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { RetrievalResponse } from '../retrieval/retrieval-v2.types';
import { ContextResolverService } from '../context/context-resolver.service.js';
import type { ContextResolutionRequest } from '../context/context-resolver.types.js';
import { MeriContextPlaneService } from './meri-context-plane.service.js';
import { parseCapiroDataSearchInput, searchCapiroData } from './meri-data-search.helpers';
import { wrapToolResultForPrompt } from '@capiro/meriv2-core';

const ctx = { tenantId: 'tenant-a', userId: 'user-a', role: 'standard_user' } as TenantContext;
const clientId = '11111111-1111-4111-8111-111111111111';
const otherClient = '22222222-2222-4222-8222-222222222222';
const input = { query: 'robotics strategy', domains: ['strategies_work', 'mail'], clientId };
const response = {
  records: [{ domain: 'strategies_work', recordId: 'strategy-1', payload: { title: 'Robotics' }, provenance: { source: 'strategy', recordId: 'strategy-1' } }],
  coverage: { complete: false, requestedDomains: ['strategies_work', 'mail'], sources: [
    { domain: 'strategies_work', nextCursor: 'strategy-page-2', hasMore: true },
    { domain: 'mail', sourceStatus: 'unavailable', stopReason: 'mailbox_not_connected' },
  ] },
} as unknown as RetrievalResponse;

function fixture() {
  const retrieve = jest.fn(async () => response);
  const resolver = new ContextResolverService({} as never, { retrieve } as never);
  const gateway = {
    requestContext: jest.fn(async ({ resolverRequest }: { resolverRequest: ContextResolutionRequest }) => ({
      kind: 'governed_packet',
      context: await resolver.resolveAndRetrieve(resolverRequest),
    })),
  };
  const tx = {
    client: { findMany: jest.fn(async () => [{ id: clientId }]) },
    integrationConnection: { findMany: jest.fn(async () => [{ id: 'mailbox-a' }]) },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _actor: string, read: (client: typeof tx) => unknown) => read(tx)),
  };
  const contextPlane = new MeriContextPlaneService(prisma as never, gateway as never);
  const security = jest.spyOn(contextPlane, 'securityEnvelope');
  return { retrieve, security, contextPlane, gateway, prisma, tx };
}

describe('search_capiro_data tool seam', () => {
  it('keeps domain coverage and follow-up cursors visible through the real prompt cap', async () => {
    const f = fixture();
    f.retrieve.mockResolvedValue({ ...response, records: [
      { domain: 'strategies_work', recordId: 'long-record', payload: { text: 'x'.repeat(30000) } },
    ] });
    const result = await searchCapiroData(ctx, input, f.contextPlane);
    const prompt = wrapToolResultForPrompt('search_capiro_data', result, 12000);
    expect(prompt).toContain('strategy-page-2');
    expect(prompt).toContain('mailbox_not_connected');
    expect(prompt).toContain('"complete": false');
    expect(prompt).toContain('[truncated tool result]');
  });

  it('uses fresh server authorization, preserves provenance/coverage and ignores supplied authority', async () => {
    const f = fixture();
    const result = await searchCapiroData(ctx, {
      ...input, caller: { tenantId: 'tenant-b', userId: 'user-b' }, authorizedClientIds: [otherClient],
      authorizedMailboxConnectionIds: ['other-mailbox'], cursors: { strategies_work: 'strategy-page-2' }, pageSize: 100,
    }, f.contextPlane);
    expect(f.security).toHaveBeenCalledWith(ctx);
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
    expect(f.gateway.requestContext).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'meri.chat',
      resolverRequest: expect.objectContaining({ subjectScope: 'client', clientId, surface: 'chat' }),
    }));
    expect(f.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      query: input.query, requestedDomains: input.domains, queryClass: 'lookup',
      cursors: { strategies_work: 'strategy-page-2' }, pageSize: 100,
      caller: { tenantId: ctx.tenantId, userId: ctx.userId, authorizedClientIds: [clientId],
        authorizedMailboxConnectionIds: ['mailbox-a'], clientIds: [clientId] },
    }));
    expect(result.records).toBe(response.records);
    expect(result.coverage).toBe(response.coverage);
  });

  it('rechecks grants on follow-up pages and rejects a revoked client before retrieving', async () => {
    const f = fixture();
    await searchCapiroData(ctx, input, f.contextPlane);
    f.security.mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] });
    await expect(searchCapiroData(ctx, { ...input, cursors: { strategies_work: 'strategy-page-2' } }, f.contextPlane))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(f.security).toHaveBeenCalledTimes(2);
    expect(f.retrieve).toHaveBeenCalledTimes(1);
  });

  it('does not broaden an empty mailbox/client envelope for a portfolio request', async () => {
    const f = fixture();
    f.security.mockResolvedValue({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] });
    await searchCapiroData(ctx, { query: 'recent work', domains: ['mail'] }, f.contextPlane);
    expect(f.retrieve).toHaveBeenCalledWith(expect.objectContaining({ caller: {
      tenantId: ctx.tenantId, userId: ctx.userId, authorizedClientIds: [], authorizedMailboxConnectionIds: [],
    } }));
  });

  it('fails closed when authorization cannot be resolved', async () => {
    const f = fixture();
    f.security.mockRejectedValue(new Error('Security scope unavailable'));
    await expect(searchCapiroData(ctx, input, f.contextPlane)).rejects.toThrow('Security scope unavailable');
    expect(f.retrieve).not.toHaveBeenCalled();
  });

  it('reports an unavailable service without pretending it searched or found no data', async () => {
    await expect(searchCapiroData(ctx, input)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    { query: 4 }, { domains: [] }, { domains: ['unknown_domain'] }, { pageSize: 101 },
    { queryClass: 'invented' }, { clientId: 'other client' },
    { cursors: { hearings: 'not-requested' } }, { cursors: { mail: '' } },
    { windowStart: '2026-09-06' },
    { windowStart: '2026-09-06T00:00:00Z', windowEnd: '2026-09-05T00:00:00Z' },
  ])('rejects unsupported options before data access: %p', async (options) => {
    const f = fixture();
    await expect(searchCapiroData(ctx, { ...input, ...options }, f.contextPlane)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.security).not.toHaveBeenCalled();
    expect(f.retrieve).not.toHaveBeenCalled();
  });

  it('preserves bounded dates and the existing exhaustive retrieval contract', async () => {
    const f = fixture();
    await searchCapiroData(ctx, { ...input, queryClass: 'exhaustive_search',
      windowStart: '2026-09-01T00:00:00Z', windowEnd: '2026-09-06T00:00:00Z',
    }, f.contextPlane);
    expect(f.retrieve).toHaveBeenCalledWith(expect.objectContaining({ requireComplete: true,
      windowStart: new Date('2026-09-01T00:00:00Z'), windowEnd: new Date('2026-09-06T00:00:00Z'),
    }));
    expect(parseCapiroDataSearchInput({ ...input, domains: ['mail', 'mail'] }).domains).toEqual(['mail']);
  });

  it('enumerates all selected client work without inventing a text filter', async () => {
    const f = fixture();
    await searchCapiroData(ctx, { query: '', domains: ['strategies_work', 'action_recommendations'], clientId,
      queryClass: 'exhaustive_search',
    }, f.contextPlane);
    expect(f.retrieve).toHaveBeenCalledWith(expect.objectContaining({ query: undefined,
      queryClass: 'exhaustive_search', requireComplete: true,
      requestedDomains: ['strategies_work', 'action_recommendations'],
      caller: expect.objectContaining({ clientIds: [clientId], authorizedClientIds: [clientId] }),
    }));
  });
});


describe('exact canonical memory reads', () => {
  it('passes exact item narrowing through the authenticated shared plane', async () => {
    const f = fixture();
    await searchCapiroData(ctx, { query: 'Read approved memory', domains: ['institutional_knowledge'], queryClass: 'lookup', memoryItemId: otherClient, clientId }, f.contextPlane);
    expect(f.retrieve).toHaveBeenCalledWith(expect.objectContaining({ memoryItemId: otherClient, caller: expect.objectContaining({ clientIds: [clientId] }) }));
  });
  it.each([
    { domains: ['mail'] }, { domains: ['institutional_knowledge', 'mail'] },
    { queryClass: 'exhaustive_search' }, { memoryItemId: 'invalid-id' },
  ])('rejects an exact memory selector for an unsupported shape %j', (override) => {
    expect(() => parseCapiroDataSearchInput({ query: 'Read memory', domains: ['institutional_knowledge'], memoryItemId: otherClient, ...override })).toThrow(BadRequestException);
  });
});
