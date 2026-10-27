import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryOwnerItemsService } from './memory-owner-items.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user',
  role: 'standard_user',
};

const first: {
  id: string;
  title: string;
  sourceType: string | null;
  clientId: string | null;
  sections: unknown;
  updatedAt: string;
} = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Own memory',
  sourceType: null,
  clientId: null,
  sections: [
    { key: 'one', body: '  First fact.  ' },
    { key: 'two', body: 'Second fact.' },
  ],
  updatedAt: '2026-10-18T12:43:22.123456Z',
};
const second = {
  ...first,
  id: '44444444-4444-4444-8444-444444444444',
  updatedAt: '2026-10-18T12:43:21.654321Z',
};

function harness(pages: Array<Array<typeof first>>) {
  const queries: Prisma.Sql[] = [];
  const contexts: Array<[string, string]> = [];
  const prisma = {
    withTenantUser: async (
      tenantId: string,
      userId: string,
      run: (tx: object) => Promise<unknown>,
    ) => {
      contexts.push([tenantId, userId]);
      return run({
        $queryRaw: async (sql: Prisma.Sql) => {
          queries.push(sql);
          return pages.shift() ?? [];
        },
      });
    },
  } as unknown as PrismaService;
  return { service: new MemoryOwnerItemsService(prisma), queries, contexts };
}

describe('MemoryOwnerItemsService', () => {
  const oldLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  const oldTenants = process.env.MEMORY_GOVERNANCE_TENANTS;

  beforeEach(() => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
  });

  afterEach(() => {
    if (oldLifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = oldLifecycle;
    if (oldTenants === undefined) delete process.env.MEMORY_GOVERNANCE_TENANTS;
    else process.env.MEMORY_GOVERNANCE_TENANTS = oldTenants;
  });

  it('filters exact owner, private scope, current controlling version, hold and expiry before LIMIT', async () => {
    const { service, queries, contexts } = harness([[first]]);
    await expect(service.list(ctx)).resolves.toEqual({
      schemaVersion: 1,
      items: [
        {
          id: first.id,
          title: 'Own memory',
          value: 'First fact.\n\nSecond fact.',
          displayTitle: 'Own memory',
          contentStatus: 'available',
          contentLimitation: null,
          scope: 'user_private',
          clientId: null,
          updatedAt: first.updatedAt,
        },
      ],
      nextCursor: null,
    });
    expect(contexts).toEqual([[ctx.tenantId, ctx.userId]]);
    const sql = queries[0]?.strings.join('?') ?? '';
    expect(sql).toContain('mi.source_type AS "sourceType"');
    expect(sql).toContain('mi.owner_user_id =');
    expect(sql).toContain("mi.memory_scope = 'user_private'");
    expect(sql).toContain("mi.visibility = 'user'");
    expect(sql).toContain('mi.client_id IS NULL');
    expect(sql).toContain('mi.legal_hold IS FALSE');
    expect(sql).toContain('mi.controlling_item_id IS NULL OR mi.controlling_item_id = mi.id');
    expect(sql).toContain("mi.status = 'active'");
    expect(sql).toContain('mi.effective_from <= now()');
    expect(sql).toContain('mi.valid_until > now()');
    expect(sql).toContain('mi.expires_at > now()');
    expect(sql).toContain('ORDER BY mi.updated_at DESC, mi.id DESC');
    expect(queries[0]?.values).toContain(26);
  });

  it.each([
    {
      title: 'learning-signal:accepted-rating',
      sourceType: null,
      body: JSON.stringify({
        summary: 'meri_feedback_positive on meri.chat',
        note: 'Review the referenced evidence objects for full context before approving.',
      }),
      displayTitle: 'Learning capture — source fact unavailable',
    },
    {
      title: 'Renamed learning record',
      sourceType: 'learning_signal_capture',
      body: JSON.stringify({ summary: 'crm_finding_accepted on crm.fill_with_meri' }),
      displayTitle: 'Renamed learning record',
    },
    {
      title: 'learning-signal:legacy-event',
      sourceType: 'learning_signal_capture',
      body: 'No structured fact text was available for this signal.',
      displayTitle: 'Learning capture — source fact unavailable',
    },
  ])('describes metadata-only $title without replacing its correction source', async (fixture) => {
    const { service } = harness([[{ ...first, ...fixture, sections: [{ body: fixture.body }] }]]);
    const page = await service.list(ctx);
    expect(page.items).toEqual([
      {
        id: first.id,
        title: fixture.title,
        value: fixture.body,
        displayTitle: fixture.displayTitle,
        contentStatus: 'metadata_only',
        contentLimitation:
          'This approved record contains a learning-event description, not the underlying fact. The original source must be reviewed before proposing corrected content; approval of this event is not verification of an unstored capability, person or facility.',
        scope: 'user_private',
        clientId: first.clientId,
        updatedAt: first.updatedAt,
      },
    ]);
  });

  it.each([
    {
      title: 'learning-signal:actual-fact',
      sourceType: 'learning_signal_capture',
      body: 'The client has a laboratory.\nThe source describes its equipment.',
      displayTitle: 'The client has a laboratory.',
    },
    {
      title: 'User-authored JSON',
      sourceType: null,
      body: JSON.stringify({ summary: 'meri_feedback_positive on meri.chat' }),
      displayTitle: 'User-authored JSON',
    },
    {
      title: 'Learning record with a fact',
      sourceType: 'learning_signal_capture',
      body: JSON.stringify({
        summary: 'meri_feedback_positive on meri.chat',
        fact: 'The client has a laboratory.',
      }),
      displayTitle: 'Learning record with a fact',
    },
    {
      title: 'Learning record with a substantive note',
      sourceType: 'learning_signal_capture',
      body: JSON.stringify({
        summary: 'meri_feedback_positive on meri.chat',
        note: 'The client has a laboratory.',
      }),
      displayTitle: 'Learning record with a substantive note',
    },
  ])('keeps available $title readable and unchanged', async (fixture) => {
    const { service } = harness([[{ ...first, ...fixture, sections: [{ body: fixture.body }] }]]);
    const page = await service.list(ctx);
    expect(page.items[0]).toMatchObject({
      title: fixture.title,
      value: fixture.body,
      displayTitle: fixture.displayTitle,
      contentStatus: 'available',
      contentLimitation: null,
      updatedAt: first.updatedAt,
    });
  });

  it.each([{ sections: [] }, { sections: [{ body: '   ' }] }])(
    'describes an empty section body without inferring a fact (%j)',
    async ({ sections }) => {
      const { service } = harness([[{ ...first, sections }]]);
      const page = await service.list(ctx);
      expect(page.items[0]).toMatchObject({
        title: first.title,
        value: '',
        displayTitle: first.title,
        contentStatus: 'empty',
        contentLimitation:
          'This approved record has no stored section body. No source fact can be inferred from its title or approval.',
      });
    },
  );

  it('uses a microsecond keyset token and binds it to the current owner', async () => {
    const { service, queries } = harness([[first, second], [second]]);
    const page = await service.list(ctx, { limit: '1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await service.list(ctx, { limit: '1', cursor: page.nextCursor });
    expect(next.items.map((item) => item.id)).toEqual([second.id]);
    expect(next.nextCursor).toBeNull();
    expect(queries[1]?.strings.join('?')).toContain('(mi.updated_at, mi.id) <');
    expect(queries[1]?.values).toContain(first.updatedAt);
    expect(queries[1]?.values).toContain(first.id);

    const other = { ...ctx, userId: '55555555-5555-4555-8555-555555555555' };
    await expect(service.list(other, { cursor: page.nextCursor })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(queries).toHaveLength(2);
  });

  it('rejects malformed page inputs before querying', async () => {
    const { service, queries } = harness([]);
    for (const limit of ['0', '101', '1.5', 'NaN']) {
      await expect(service.list(ctx, { limit })).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const cursor of ['', '!', Buffer.from('{}').toString('base64url')]) {
      await expect(service.list(ctx, { cursor })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(queries).toHaveLength(0);
  });

  it('fails closed when lifecycle is off or a selected item cannot be rendered', async () => {
    const { service, queries } = harness([[{ ...first, sections: null }]]);
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'off';
    await expect(service.list(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(queries).toHaveLength(0);
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    await expect(service.list(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([{ sections: [{ body: null }] }, { sections: [null] }])(
    'does not turn malformed sections into a presentation (%j)',
    async ({ sections }) => {
      const { service } = harness([[{ ...first, sections }]]);
      await expect(service.list(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    },
  );
});
