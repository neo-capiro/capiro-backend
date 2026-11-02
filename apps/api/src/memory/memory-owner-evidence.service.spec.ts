import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryOwnerEvidenceService } from './memory-owner-evidence.service.js';
import {
  retainedConversationReference,
  committedConversationSource,
} from './memory-owner-evidence.sources.js';
import * as sourceAdapter from './memory-owner-evidence.sources.js';
jest.mock('./conversation-serving/transaction.js', () => ({
  withMemoryConversationRetention: (
    prisma: PrismaService,
    tenant: string,
    user: string,
    run: never,
  ) => prisma.withTenantUser(tenant, user, run),
}));
const id = '11111111-1111-4111-8111-111111111111';
const ctx = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
  role: 'standard_user',
} as TenantContext;
const previous = [process.env.MEMORY_GOVERNANCE_LIFECYCLE, process.env.MEMORY_GOVERNANCE_TENANTS];
afterEach(() => {
  for (const [i, key] of ['MEMORY_GOVERNANCE_LIFECYCLE', 'MEMORY_GOVERNANCE_TENANTS'].entries()) {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }
});
function service(rows: unknown[], subsequent?: unknown[][]) {
  process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
  process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
  const responses = subsequent ? [rows, ...subsequent] : null;
  const query = jest.fn(async () => (responses ? (responses.shift() ?? []) : rows));
  const prisma = {
    withTenantUser: async (tenant: string, user: string, work: (tx: unknown) => unknown) => {
      expect([tenant, user]).toEqual([ctx.tenantId, ctx.userId]);
      return work({ $queryRaw: query });
    },
  } as unknown as PrismaService;
  return { read: new MemoryOwnerEvidenceService(prisma), query };
}
describe('personal owner evidence', () => {
  it('rechecks the item and committed source after native authorization', async () => {
    const source = {
      conversationId: '44444444-4444-4444-8444-444444444444',
      observedAt: '2026-10-31T12:00:00.123456Z',
    };
    const anchor = { id, revision: source.observedAt };
    const reference = { kind: 'conversation' as const, id: source.conversationId, clientId: null };
    const native = jest
      .spyOn(sourceAdapter, 'retainedConversationReference')
      .mockResolvedValue(reference);
    try {
      const { read, query } = service([anchor], [[source], [anchor], [source]]);
      const result = await read.list(ctx, id, {}, 'Bearer synthetic');
      expect(result.availability).toBe('available');
      expect(result.entries).toEqual([
        { kind: 'conversation', reference, observedAt: source.observedAt },
      ]);
      expect(query).toHaveBeenCalledTimes(4);
      await expect(
        service([anchor], [[source], []]).read.list(ctx, id, {}, 'Bearer synthetic'),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      native.mockRestore();
    }
  });
  it('refuses inaccessible anchors without disclosing source existence', async () => {
    await expect(service([]).read.list(ctx, id)).rejects.toMatchObject({ status: 404 });
  });
  it('returns explicit unsupported provenance without echoing source data', async () => {
    const { read } = service([{ id, revision: '2026-10-31T12:00:00.123456Z' }]);
    expect(await read.list(ctx, id)).toEqual({
      schemaVersion: 1,
      anchor: { kind: 'item', id, revision: '2026-10-31T12:00:00.123456Z' },
      availability: 'unsupported',
      reason: 'source_reader_unbound',
      entries: [],
      nextCursor: null,
    });
  });
  it('refuses namespaced identities and cursors before dispatch', async () => {
    const { read, query } = service([]);
    await expect(read.list(ctx, `clio:${id}`)).rejects.toMatchObject({ status: 400 });
    await expect(read.list(ctx, id, { cursor: 'history-cursor' })).rejects.toMatchObject({
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('retained native conversation adapter', () => {
  const sourceId = '44444444-4444-4444-8444-444444444444';
  const env = {
    MERI_API_BASE_URL: 'https://meri.synthetic.invalid',
    CAPIRO_REQUEST_ORIGIN: 'https://frontend.synthetic.invalid',
  };
  const transcript = {
    schema: 'meri.conversation-transcript/1',
    conversation: {
      conversationId: sourceId,
      owner: { tenantId: ctx.tenantId, actorId: ctx.userId },
      scopes: [{ kind: 'private-user', tenantId: ctx.tenantId, resourceId: ctx.userId }],
    },
    events: [{ private: 'synthetic transcript must not escape' }],
  };
  it('uses the canonical authenticated bounded transcript path and projects identity only', async () => {
    const fetcher = jest.fn<typeof fetch>(async () => Response.json(transcript));
    expect(
      await retainedConversationReference(ctx, sourceId, 'Bearer synthetic', undefined, {
        env,
        fetcher,
      }),
    ).toEqual({ kind: 'conversation', id: sourceId, clientId: null });
    expect(fetcher).toHaveBeenCalledWith(
      'https://meri.synthetic.invalid/api/conversations/transcript',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer synthetic',
          Origin: 'https://frontend.synthetic.invalid',
        }),
        body: JSON.stringify({ conversationId: sourceId, after: 0, limit: 1 }),
      }),
    );
  });
  it('refuses foreign owner/tenant and malformed reader responses', async () => {
    for (const value of [
      {
        ...transcript,
        conversation: {
          ...transcript.conversation,
          owner: { tenantId: ctx.tenantId, actorId: id },
        },
      },
      {
        ...transcript,
        conversation: { ...transcript.conversation, owner: { tenantId: id, actorId: ctx.userId } },
      },
      {},
    ]) {
      await expect(
        retainedConversationReference(ctx, sourceId, 'Bearer synthetic', undefined, {
          env,
          fetcher: async () => Response.json(value),
        }),
      ).rejects.toThrow();
    }
  });
  it('withholds source references after retention/access refusal and preview narrowing', async () => {
    for (const status of [401, 403, 404, 410])
      expect(
        await retainedConversationReference(ctx, sourceId, 'Bearer synthetic', undefined, {
          env,
          fetcher: async () => new Response(null, { status }),
        }),
      ).toBeNull();
    const value = {
      ...transcript,
      conversation: {
        ...transcript.conversation,
        scopes: [{ kind: 'client', tenantId: ctx.tenantId, resourceId: id }],
      },
    };
    expect(
      await retainedConversationReference(ctx, sourceId, 'Bearer synthetic', [], {
        env,
        fetcher: async () => Response.json(value),
      }),
    ).toBeNull();
  });
  it('requires the exact approved committed candidate join and never selects candidate content', async () => {
    let sql = '';
    const tx = {
      $queryRaw: async (query: { text: string }) => {
        sql = query.text;
        return [];
      },
    } as never;
    expect(await committedConversationSource(tx, ctx, id)).toBeNull();
    expect(sql).toContain('mi.id=mc.committed_memory_item_id');
    expect(sql).toContain("mc.status='approved'");
    expect(sql).toContain("mc.provenance_jsonb->'origin'->>'kind'='conversation'");
    expect(sql).not.toContain('payload_jsonb');
    expect(sql).not.toContain('sourceConversationId');
  });
});
