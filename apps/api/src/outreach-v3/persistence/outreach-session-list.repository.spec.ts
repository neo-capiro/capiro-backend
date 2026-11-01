import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { OutreachStateRepository } from './outreach-state.repository.js';

/**
 * `listOwnedSessions` backs the Outreach home screen (the draft/sent campaign
 * list). It reads three things a plain `outreach_sessions` row cannot give:
 *
 *   - the campaign NAME. A session's `title` is written once at creation and
 *     never updated, so it is the literal string "New outreach campaign" for
 *     every campaign a user has ever started. The real name is
 *     `spec.goal.topic` on the session's current state version.
 *   - the target COUNT, from that same spec version.
 *   - whether the campaign was actually SENT. No code path ever advances a
 *     session's own status to 'completed'; the only durable send record is the
 *     compatibility artifact root (id-equal to the session), which
 *     OutreachSendIntentService.rollUpIntent updates on a completed real send.
 *
 * These assertions pin the shape those three reads depend on, because a silent
 * regression here would make the home screen show identically-named rows, or
 * under-report a real send as a draft.
 */
describe('OutreachStateRepository.listOwnedSessions', () => {
  const ctx: TenantContext = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
  } as TenantContext;

  function harness(rows: unknown[], roots: unknown[] = []) {
    const seen: { sql: string; values: unknown[]; recordWhere?: unknown } = { sql: '', values: [] };
    const tx = {
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        seen.sql = strings.join('?');
        seen.values = values;
        return Promise.resolve(rows);
      },
      outreachRecord: {
        findMany: (args: { where?: unknown }) => {
          seen.recordWhere = args.where;
          return Promise.resolve(roots);
        },
      },
    } as unknown as Prisma.TransactionClient;
    return { repository: new OutreachStateRepository(), tx, seen };
  }

  const list = (
    repository: OutreachStateRepository,
    tx: Prisma.TransactionClient,
    over: Partial<{ limit: number; offset: number; includeArchived: boolean; search: string }> = {},
  ) =>
    repository.listOwnedSessions(tx, ctx, {
      limit: 25,
      offset: 0,
      includeArchived: false,
      ...over,
    });

  it('reads the campaign name and target count from the current spec version', async () => {
    const { repository, tx, seen } = harness([]);
    await list(repository, tx);

    expect(seen.sql).toContain("v.spec_jsonb -> 'goal' ->> 'topic'");
    expect(seen.sql).toContain("v.spec_jsonb -> 'goal' ->> 'goal'");
    expect(seen.sql).toContain('jsonb_array_length');
    expect(seen.sql).toContain("'selectedTargetRefs'");
    // Joined on the session's CURRENT version, not an arbitrary one.
    expect(seen.sql).toContain('v.version = s.current_state_version');
    // LEFT, and tenant-predicated in its own ON clause, so an unreadable spec
    // version cannot make a session disappear from its owner's campaign list.
    expect(seen.sql).toContain('LEFT JOIN outreach_state_versions v');
    expect(seen.sql).toContain('v.tenant_id = s.tenant_id');
  });

  it('keeps owner scoping and paging fully parameterized', async () => {
    const { repository, tx, seen } = harness([]);
    await list(repository, tx, { limit: 10, offset: 5, includeArchived: true });

    expect(seen.sql).toContain('s.tenant_id = CAST(');
    expect(seen.sql).toContain('s.created_by_user_id = CAST(');
    expect(seen.sql).toContain("s.status <> 'archived'");
    expect(seen.values).toEqual([ctx.tenantId, ctx.userId, true, null, null, null, null, 10, 5]);
  });

  it('filters literal title/topic/goal search before pagination, including beyond the first 100', async () => {
    const { repository, tx, seen } = harness([]);
    await list(repository, tx, { search: '  50%_\\ topic  ', limit: 25, offset: 100 });
    const where = seen.sql.slice(seen.sql.indexOf('WHERE'), seen.sql.indexOf('ORDER BY'));
    expect(where).toContain("strpos(lower(COALESCE(s.title, '')), lower(?)) > 0");
    expect(where).toContain(
      "strpos(lower(COALESCE(v.spec_jsonb -> 'goal' ->> 'topic', '')), lower(?)) > 0",
    );
    expect(where).toContain(
      "strpos(lower(COALESCE(v.spec_jsonb -> 'goal' ->> 'goal', '')), lower(?)) > 0",
    );
    expect(where).not.toContain('ILIKE');
    expect(seen.values).toEqual([
      ctx.tenantId,
      ctx.userId,
      false,
      ...Array(4).fill('50%_\\ topic'),
      25,
      100,
    ]);
    expect(seen.sql.indexOf('ORDER BY')).toBeLessThan(seen.sql.indexOf('LIMIT'));
  });

  it('treats whitespace search as the existing unfiltered query', async () => {
    const { repository, tx, seen } = harness([]);
    await list(repository, tx, { search: '   ' });
    expect(seen.values).toEqual([ctx.tenantId, ctx.userId, false, null, null, null, null, 25, 0]);
    expect(seen.sql).toContain('CAST(? AS text) IS NULL');
  });

  it('reads draft-vs-sent from the artifact root, scoped to tenant and the reserved type', async () => {
    const { repository, tx, seen } = harness(
      [{ id: 'session-a' }, { id: 'session-b' }],
      [
        {
          id: 'session-a',
          type: 'outreach_v3',
          status: 'sent',
          sentAt: new Date('2026-08-17T00:00:00.000Z'),
        },
      ],
    );
    const rows = await list(repository, tx);

    expect(seen.recordWhere).toEqual({
      tenantId: ctx.tenantId,
      createdByUserId: ctx.userId,
      id: { in: ['session-a', 'session-b'] },
      type: { in: ['outreach_v3', 'campaign'] },
    });
    expect(rows[0]).toMatchObject({
      id: 'session-a',
      recordStatus: 'sent',
      sentAt: new Date('2026-08-17T00:00:00.000Z'),
    });
    // No artifact root yet = no recorded send. Never a claimed one.
    expect(rows[1]).toMatchObject({
      id: 'session-b',
      recordStatus: null,
      sentAt: null,
      hasWorkflow: false,
    });
  });

  it('identifies imported canonical workflows on every legacy page without hiding unimported sessions', async () => {
    const { repository, tx } = harness(
      [{ id: 'old-import' }, { id: 'new-import' }, { id: 'legacy' }, { id: 'deleted-import' }],
      [
        {
          id: 'old-import',
          type: 'campaign',
          status: 'draft',
          sentAt: null,
          metadata: { workflow: { revision: 1 } },
        },
        {
          id: 'new-import',
          type: 'outreach_v3',
          status: 'sent',
          sentAt: null,
          metadata: { workflow: { revision: 2 } },
        },
        { id: 'legacy', type: 'outreach_v3', status: 'draft', sentAt: null, metadata: {} },
        {
          id: 'deleted-import',
          type: 'campaign',
          status: 'draft',
          sentAt: null,
          deletedAt: new Date(),
          metadata: { workflow: { revision: 1 } },
        },
      ],
    );
    expect(
      (await list(repository, tx, { offset: 100 })).map((row) => [row.id, row.hasWorkflow]),
    ).toEqual([
      ['old-import', true],
      ['new-import', true],
      ['legacy', false],
      ['deleted-import', true],
    ]);
  });

  it('never names a legacy Outreach table in raw SQL, and never treats status=completed as a send', async () => {
    const { repository, tx, seen } = harness([]);
    await list(repository, tx);

    // The Phase 2 architecture boundary (outreach-v3-phase2-architecture.spec.ts)
    // forbids raw legacy-table SQL anywhere under src/outreach-v3; the Prisma
    // model accessor asserted above is the sanctioned route.
    for (const table of [
      'outreach_records',
      'outreach_draft_artifacts',
      'outreach_send_intents',
      'outreach_deliveries',
    ]) {
      expect(seen.sql).not.toContain(table);
    }
    expect(seen.sql).not.toContain("'completed'");
  });

  it('uses the reserved artifact-root type retained by the state owner', () => {
    // The type string is declared locally to avoid a persistence→drafts module
    // dependency, so it needs a real cross-check rather than a copy of itself.
    const service = readFileSync(resolve(__dirname, './outreach-state.repository.ts'), 'utf8');
    expect(service).toContain("OUTREACH_V3_ARTIFACT_ROOT_TYPE = 'outreach_v3'");
  });

  it('skips the artifact-root read entirely when there are no sessions', async () => {
    const { repository, tx, seen } = harness([]);
    const rows = await list(repository, tx);
    expect(rows).toEqual([]);
    expect(seen.recordWhere).toBeUndefined();
  });

  it('normalizes a bigint or null target count to a plain number', async () => {
    // $queryRaw can surface an integer aggregate as a BigInt depending on the
    // driver path; a BigInt would throw on JSON serialization at the API edge.
    const { repository, tx } = harness([
      { id: 'a', targetCount: BigInt(12) },
      { id: 'b', targetCount: null },
      { id: 'c', targetCount: 3 },
    ]);
    const rows = await list(repository, tx);

    expect(rows.map((row) => row.targetCount)).toEqual([12, 0, 3]);
    for (const row of rows) expect(typeof row.targetCount).toBe('number');
    expect(() => JSON.stringify(rows)).not.toThrow();
  });
});
