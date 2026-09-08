import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { queryMailMessages } from './mail-query.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Canonical mailbox queries retain scope, literal lookup, bounded pages and honest coverage. */

const CTX = {
  tenantId: 'a8dce0a5-af14-46fd-bb7e-f7f754556d3e',
  userId: 'cc01a549-5381-4ebd-b714-ec8c597392f6',
} as unknown as TenantContext;

type SearchEmails = (
  ctx: TenantContext,
  input: Record<string, unknown>,
) => Promise<{
  error?: string;
  totalMatches?: number;
  returned?: number;
  hasMore?: boolean;
  messages?: Array<Record<string, unknown>>;
  searchedMailboxes?: Array<Record<string, unknown>>;
  notes?: string[];
  nextOffset?: number | null;
  asOf?: string;
  timeWindow?: { start: string | null; end: string };
}>;

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-1',
    thread_id: 'thread-1',
    subject: 'RE: Adam Wilczewski <> Radiant Nuclear',
    from_email: 'awilczewski@porterwright.com',
    from_name: 'Wilczewski, Adam S.',
    to_recipients: [{ email: 'jeff.j.burton@mavenadvocacy.com', name: 'Jeff Burton' }],
    cc_recipients: [],
    sent_at: new Date('2026-07-08T17:41:06Z'),
    received_at: new Date('2026-07-08T17:41:32Z'),
    preview: 'No worries on our end. Looping John Howell...',
    has_attachments: false,
    folder: 'inbox',
    internet_message_id: '<abc@porterwright.com>',
    client_id: null,
    client_name: null,
    account_email: 'jeff.j.burton@mavenadvocacy.com',
    ...overrides,
  };
}

function healthyMailbox(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    account_email: 'jeff.j.burton@mavenadvocacy.com',
    provider: 'microsoft_365',
    status: 'connected',
    last_sync_at: new Date('2026-07-18T21:18:48Z'),
    synced_messages: 1562,
    oldest_synced: new Date('2025-07-03T15:45:01Z'),
    newest_synced: new Date('2026-07-18T01:31:26Z'),
    ...overrides,
  };
}

/** Stub prisma so withTenant hands the handler a tx whose $queryRaw returns, in
 * order: the distinct count, the message rows, then the coverage rows. */
function makeService(input: { count?: number; rows?: unknown[]; coverage?: unknown[] }) {
  const queryRaw = jest
    .fn()
    .mockResolvedValueOnce([{ n: input.count ?? 0 }])
    .mockResolvedValueOnce(input.rows ?? [])
    .mockResolvedValueOnce(input.coverage ?? []);
  const prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $queryRaw: queryRaw }),
  };
  const searchEmails: SearchEmails = (ctx, input) =>
    queryMailMessages(prisma as unknown as PrismaService, ctx, input);
  return { searchEmails, queryRaw };
}

/** All parameter values bound into the nth $queryRaw call's Prisma.Sql. */
function boundValues(queryRaw: jest.Mock, call: number): unknown[] {
  const sql = queryRaw.mock.calls[call]![0] as Prisma.Sql;
  return sql.values;
}

describe('canonical mailbox query', () => {
  it('accepts a date-only inbox inventory and binds a stable 14-day window without a keyword', async () => {
    const { searchEmails, queryRaw } = makeService({ coverage: [healthyMailbox()] });
    const out = await searchEmails(CTX, {
      withinDays: 14,
      folder: 'inbox',
      asOf: '2026-09-07T12:00:00Z',
    });
    expect(out.error).toBeUndefined();
    expect(out.timeWindow).toEqual({
      start: '2026-08-24T12:00:00.000Z',
      end: '2026-09-07T12:00:00.000Z',
    });
    const sql = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("lower(m.metadata_jsonb->>'folder') = 'inbox'");
    expect(sql.sql).toContain('m.removed_at IS NULL');
    expect(sql.sql).not.toContain('ILIKE');
    expect(sql.values).toContainEqual(new Date('2026-08-24T12:00:00Z'));
  });

  it.each([
    { withinDays: 0 },
    { withinDays: 'two weeks' },
    { folder: 'trash' },
    { withinDays: 14, offset: 50 },
    { withinDays: 14, offset: -1 },
    { withinDays: 14, asOf: 'not-a-date' },
    { withinDays: 14, limit: 51 },
  ])('rejects invalid inventory or continuation input before SQL: %j', async (input) => {
    const { searchEmails, queryRaw } = makeService({});
    expect((await searchEmails(CTX, input)).error).toBeDefined();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('returns a continuation offset with the same time boundary', async () => {
    const { searchEmails } = makeService({ count: 4, rows: [row()], coverage: [healthyMailbox()] });
    const out = await searchEmails(CTX, {
      withinDays: 14,
      folder: 'inbox',
      offset: 2,
      asOf: '2026-09-07T12:00:00Z',
    });
    expect(out).toMatchObject({
      returned: 1,
      totalMatches: 4,
      nextOffset: 3,
      hasMore: true,
      asOf: '2026-09-07T12:00:00.000Z',
    });
  });

  it('does not label calendar connection success as completed mail sync', async () => {
    const { searchEmails } = makeService({
      coverage: [
        healthyMailbox({
          sync_state: { calendar: { updatedAt: '2026-09-07T12:00:00Z' } },
          synced_messages: 0,
        }),
      ],
    });
    const out = await searchEmails(CTX, { withinDays: 14, folder: 'inbox' });
    expect(out.searchedMailboxes?.[0]).toMatchObject({
      lastSyncAt: null,
      mailCoverage: { sourceStatus: 'degraded', reason: 'mail_never_synced' },
    });
    expect(out.notes?.join('\n')).not.toContain('Bodies are stored as short previews');
  });

  it('fails closed when no search term is given (no recent-mail dump)', async () => {
    const { searchEmails, queryRaw } = makeService({});
    const out = await searchEmails(CTX, {});
    expect(out.error).toMatch(/at least one of 'query', 'from', or 'participant'/i);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('fails closed on a non-UUID clientId before it can reach the ::uuid cast', async () => {
    const { searchEmails, queryRaw } = makeService({});
    const out = await searchEmails(CTX, { query: 'olivet', clientId: 'Olivet University' });
    expect(out.error).toMatch(/client UUID/i);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('escapes LIKE wildcards in model-supplied terms so they match literally', async () => {
    const { searchEmails, queryRaw } = makeService({ coverage: [healthyMailbox()] });
    await searchEmails(CTX, { query: '100%_bonus\\plan' });
    const values = boundValues(queryRaw, 0);
    expect(values).toContain('%100\\%\\_bonus\\\\plan%');
  });

  it('scopes every query to the tenant and the caller-owned connections', async () => {
    const { searchEmails, queryRaw } = makeService({ coverage: [healthyMailbox()] });
    await searchEmails(CTX, { participant: 'wilczewski' });
    // count, rows, and coverage all bind both scope uuids
    for (const call of [0, 1, 2]) {
      const values = boundValues(queryRaw, call);
      expect(values).toContain(CTX.tenantId);
      expect(values).toContain(CTX.userId);
    }
  });

  it('deduplicates folder copies in SQL before applying the page limit', async () => {
    const { searchEmails, queryRaw } = makeService({
      count: 1,
      rows: [row({ id: 'copy-inbox', folder: 'inbox', internet_message_id: '<same@x>' })],
      coverage: [healthyMailbox()],
    });
    const out = await searchEmails(CTX, { from: 'wilczewski' });
    expect(out.returned).toBe(1);
    expect(out.messages).toHaveLength(1);
    expect(out.messages![0]!.folder).toBe('inbox');
    const sql = queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(sql.sql).toContain('DISTINCT ON (m.connection_id');
    expect(sql.sql.indexOf('DISTINCT ON')).toBeLessThan(sql.sql.indexOf('LIMIT'));
    expect(out.hasMore).toBe(false);
  });

  it('keeps distinct messages, trims to limit, and reports hasMore from the distinct total', async () => {
    const { searchEmails } = makeService({
      count: 9,
      rows: [
        row({ id: 'a', internet_message_id: '<a@x>' }),
        row({ id: 'b', internet_message_id: '<b@x>' }),
      ],
      coverage: [healthyMailbox()],
    });
    const out = await searchEmails(CTX, { query: 'radiant', limit: 2 });
    expect(out.returned).toBe(2);
    expect(out.totalMatches).toBe(9);
    expect(out.hasMore).toBe(true);
  });

  it('returns messages shaped for follow-up tools (threadId for reply_email, from/to/cc, preview)', async () => {
    const { searchEmails } = makeService({
      count: 1,
      rows: [row()],
      coverage: [healthyMailbox()],
    });
    const out = await searchEmails(CTX, { participant: 'wilczewski' });
    const msg = out.messages![0]!;
    expect(msg.threadId).toBe('thread-1');
    expect(msg.from).toEqual({
      email: 'awilczewski@porterwright.com',
      name: 'Wilczewski, Adam S.',
    });
    expect(msg.to).toEqual([{ email: 'jeff.j.burton@mavenadvocacy.com', name: 'Jeff Burton' }]);
    expect(msg.preview).toMatch(/John Howell/);
    expect(msg.mailbox).toBe('jeff.j.burton@mavenadvocacy.com');
  });

  it('calls out a connected-but-never-synced mailbox instead of silently "searching" it', async () => {
    const { searchEmails } = makeService({
      count: 0,
      rows: [],
      coverage: [
        healthyMailbox(),
        healthyMailbox({
          account_email: 'jeff.j.burton@gmail.com',
          provider: 'google_workspace',
          status: 'needs_configuration',
          last_sync_at: null,
          synced_messages: 0,
          oldest_synced: null,
          newest_synced: null,
        }),
      ],
    });
    const out = await searchEmails(CTX, { query: 'dudziak' });
    expect(out.totalMatches).toBe(0);
    expect(out.searchedMailboxes).toHaveLength(2);
    expect(out.notes!.join('\n')).toMatch(/jeff\.j\.burton@gmail\.com.*NO synced mail/);
    // the standing caveat is always present
    expect(out.notes!.join('\n')).toMatch(/excluded from sync/i);
  });

  it('short-circuits with a clear note when the user has no mail connection at all', async () => {
    const { searchEmails } = makeService({ count: 0, rows: [], coverage: [] });
    const out = await searchEmails(CTX, { query: 'anything' });
    expect(out.totalMatches).toBe(0);
    expect(out.messages).toEqual([]);
    expect(out.notes!.join('\n')).toMatch(/No connected mailbox/i);
  });
});
