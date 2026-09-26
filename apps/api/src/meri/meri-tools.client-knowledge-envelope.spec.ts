import { MeriToolsService } from './meri-tools.service.js';
import type { TenantContext } from '@capiro/shared';
import { BadRequestException } from '@nestjs/common';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId, userId: 'user-a', role: 'member' } as TenantContext;

function harness(options: {
  client?: { id: string; name: string } | null;
  allowed?: boolean;
  results?: Array<{ kind: string; id: string; title: string; snippet: string; score: number }>;
  searchError?: Error;
} = {}) {
  const tenantScopes: string[] = [];
  const findFirst = jest
    .fn()
    .mockResolvedValue(options.client === undefined ? { id: clientId, name: 'Test client' } : options.client);
  const prisma = {
    withTenant: jest.fn(async (scope: string, callback: (tx: unknown) => unknown) => {
      tenantScopes.push(scope);
      if (scope !== tenantId) throw new Error('cross-tenant query rejected');
      return callback({ client: { findFirst } });
    }),
  };
  const searchWithAccess = jest.fn(async () => {
    if (options.searchError) throw options.searchError;
    return {
      authorized: options.allowed ?? options.client !== null,
      results: options.results ?? [],
    };
  });
  const service = Object.assign(Object.create(MeriToolsService.prototype), {
    prisma,
    clientKb: { searchWithAccess },
    logger: { warn: jest.fn() },
  }) as MeriToolsService;
  const run = (input: Record<string, unknown>) =>
    (service as unknown as {
      searchClientKnowledge: (actor: TenantContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }).searchClientKnowledge(ctx, input);
  return { run, findFirst, searchWithAccess, tenantScopes };
}

describe('search_client_knowledge result envelope', () => {
  it('publishes only the supported KB kind values in the model schema', () => {
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    const schema = service.anthropicToolSchemas().find((tool) => tool.name === 'search_client_knowledge');
    expect((schema?.input_schema.properties as Record<string, { enum?: string[] }>).kind?.enum).toEqual([
      'client_profile',
      'client_person',
      'client_facility',
      'client_doc_chunk',
    ]);
  });

  it('marks missing client context as needs_input without searching', async () => {
    const h = harness();
    const result = await h.run({ query: 'capabilities' });
    expect(result.outcome).toBe('needs_input');
    expect(result.coverage).toMatchObject({ searched: false, sourceStatus: 'not_searched', returned: 0 });
    expect(result.results).toEqual([]);
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.searchWithAccess).not.toHaveBeenCalled();
  });

  it('rejects malformed client IDs before checking any tenant or client data', async () => {
    const h = harness();
    await expect(h.run({ query: 'capabilities', clientId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.tenantScopes).toEqual([]);
    expect(h.searchWithAccess).not.toHaveBeenCalled();
  });

  it('rejects non-string client IDs instead of treating falsy values as omitted', async () => {
    for (const clientIdValue of [0, false, {}]) {
      const h = harness();
      await expect(h.run({ query: 'capabilities', clientId: clientIdValue })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.tenantScopes).toEqual([]);
      expect(h.searchWithAccess).not.toHaveBeenCalled();
    }
  });

  it('rejects unsupported kinds instead of broadening the query', async () => {
    const h = harness();
    await expect(h.run({ query: 'capabilities', clientId, kind: 'secret_other_kind' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.tenantScopes).toEqual([]);
    expect(h.searchWithAccess).not.toHaveBeenCalled();
  });

  it('rejects non-string kinds instead of treating falsy values as no filter', async () => {
    for (const kind of [0, false, {}]) {
      const h = harness();
      await expect(h.run({ query: 'capabilities', clientId, kind })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.tenantScopes).toEqual([]);
      expect(h.searchWithAccess).not.toHaveBeenCalled();
    }
  });

  it('distinguishes a successful empty ranked search from unavailable or complete-corpus empty', async () => {
    const h = harness({ results: [] });
    const result = await h.run({ query: 'rare capability', clientId });
    expect(result.outcome).toBe('empty');
    expect(result.coverage).toMatchObject({
      searched: true,
      sourceStatus: 'available',
      returned: 0,
      complete: false,
      completeness: 'ranked_top_k',
    });
    expect(result.sources).toEqual([]);
  });

  it('reports backend outage structurally while preserving legacy empty results and note', async () => {
    const h = harness({ searchError: new Error('embedding backend down') });
    const result = await h.run({ query: 'capabilities', clientId });
    expect(result.outcome).toBe('unavailable');
    expect(result.results).toEqual([]);
    expect(result.note).toMatch(/temporarily unavailable/);
    expect(result.coverage).toMatchObject({ searched: false, sourceStatus: 'unavailable', returned: 0 });
    expect(result.sources).toEqual([]);
    expect(result).not.toHaveProperty('clientName');
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('does not reveal a wall denial through a structured blocked outcome', async () => {
    const h = harness({ allowed: false });
    await expect(h.run({ query: 'capabilities', clientId })).rejects.toThrow('Client not found');
    expect(h.searchWithAccess).toHaveBeenCalledTimes(1);
    expect(h.findFirst).not.toHaveBeenCalled();
  });

  it('keeps revoked and nonexistent client IDs indistinguishable', async () => {
    const secret = { kind: 'client_profile', id: 'sensitive-source', title: 'Secret', snippet: 'Do not return', score: 0.9 };
    const walled = harness({ allowed: false, results: [secret] });
    const missing = harness({ client: null });
    const [walledResult, missingResult] = await Promise.allSettled([
      walled.run({ query: 'capabilities', clientId }),
      missing.run({ query: 'capabilities', clientId }),
    ]);
    expect([walledResult, missingResult].map((result) =>
      result.status === 'rejected' ? result.reason.message : 'resolved',
    )).toEqual(['Client not found', 'Client not found']);
    expect(walled.findFirst).not.toHaveBeenCalled();
    expect(missing.findFirst).not.toHaveBeenCalled();
    expect(walled.searchWithAccess).toHaveBeenCalledTimes(1);
    expect(missing.searchWithAccess).toHaveBeenCalledTimes(1);
  });

  it('pins client lookup and search to the authenticated tenant and user', async () => {
    const h = harness();
    await h.run({ query: 'capabilities', clientId });
    expect(h.tenantScopes).toEqual([tenantId]);
    expect(h.searchWithAccess).toHaveBeenCalledWith(tenantId, {
      query: 'capabilities', clientId, userId: ctx.userId, kind: undefined, limit: undefined,
    });
  });

  it('returns typed source identity for each hit without fabricating freshness', async () => {
    const hit = { kind: 'client_doc_chunk', id: 'doc-1:section-3', title: 'Capabilities', snippet: 'Text', score: 0.8 };
    const h = harness({ results: [hit] });
    const result = await h.run({ query: 'capabilities', clientId });
    expect(result.results).toEqual([hit]);
    expect(result.sources).toEqual([{ sourceType: 'client_doc_chunk', sourceId: 'doc-1:section-3', clientId }]);
    expect(result).not.toHaveProperty('freshness');
    expect(result.coverage).toMatchObject({ returned: 1, complete: false, completeness: 'ranked_top_k' });
  });

  it('echoes and forwards a supported kind as the effective scope', async () => {
    const h = harness();
    const result = await h.run({ query: 'capabilities', clientId, kind: 'client_doc_chunk' });
    expect(h.searchWithAccess).toHaveBeenCalledWith(tenantId, expect.objectContaining({ kind: 'client_doc_chunk' }));
    expect(result.coverage).toMatchObject({ scope: { clientId, kind: 'client_doc_chunk' } });
  });
});
