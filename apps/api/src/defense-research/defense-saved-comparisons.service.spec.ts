import { DefenseSavedComparisonsService } from './defense-saved-comparisons.service.js';
import type { SaveDefenseComparisonDto, TenantContext } from '@capiro/shared';
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const basis = {
  requestEdition: 'PB26',
  fundingFiscalYear: 2026,
  stage: 'request',
  metric: 'funding',
  unit: 'usd_millions',
  currency: 'USD',
  priceBasis: null,
  asOfDate: null,
  periodStart: null,
  periodEnd: null,
};
const input = (): SaveDefenseComparisonDto => ({
  schemaVersion: 'defense_saved_comparison_v1',
  displayVersion: 'defense-compare-display-v1',
  name: 'Owned capture',
  subjects: [
    { type: 'program_element', id: '0600000A' },
    { type: 'program_element', id: '0600001A' },
  ],
  selection: {
    mode: 'explicit',
    subjectKeys: ['program_element:0600000A', 'program_element:0600001A'],
    passageIds: [],
  },
  basisPair: { left: basis, right: { ...basis, requestEdition: 'PB27' } },
  passageMode: 'none',
  contextualRevisionPins: [],
  idempotencyKey: 'save-1',
});
function fixture() {
  let member = true,
    grant = true,
    portfolioLifecycle = 'active',
    portfolioRole = 'owner',
    portfolioRevision = 1,
    readCalls = 0,
    sourceValue = '0';
  const parents: any[] = [],
    versions: any[] = [],
    events: any[] = [],
    calls: any[] = [],
    members: any[] = [],
    bookmarks: any[] = [],
    portfolioEvents: any[] = [];
  const match = (row: any, where: any) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const tx: any = {
    $executeRaw: async (...args: any[]) => {
      calls.push(['lock', args]);
      return 1;
    },
    tenantMembership: {
      findFirst: async ({ where }: any) => {
        calls.push(['member', where]);
        return member ? { id: 'member' } : null;
      },
    },
    researchPortfolio: {
      updateMany: async ({ where, data }: any) => {
        if (where.revision !== portfolioRevision) return { count: 0 };
        portfolioRevision = data.revision;
        return { count: 1 };
      },
      findFirst: async ({ where }: any) => {
        calls.push(['portfolio', where]);
        return grant &&
          (!where.lifecycle || where.lifecycle === portfolioLifecycle) &&
          (!where.grants.some.role || where.grants.some.role.in.includes(portfolioRole))
          ? {
              id: where.id,
              lifecycle: portfolioLifecycle,
              revision: portfolioRevision,
              grants: [{ role: portfolioRole }],
              clientLinks: [],
            }
          : null;
      },
    },
    programElement: {
      findUnique: async ({ where }: any) => ({
        peCode: where.peCode,
        title: 'Canonical ' + where.peCode,
      }),
    },
    capabilityBudgetLineMatch: { findMany: async () => [] },
    researchPortfolioMember: {
      findUnique: async ({ where }: any) =>
        members.find((row) => match(row, where.tenantId_portfolioId_targetKind_targetId)) ?? null,
      create: async ({ data }: any) => {
        const row = { ...data, id: 'member-' + members.length };
        members.push(row);
        return row;
      },
    },
    researchPortfolioBookmark: {
      findFirst: async ({ where }: any) => bookmarks.find((row) => match(row, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { ...data, id: 'bookmark-' + bookmarks.length };
        bookmarks.push(row);
        return row;
      },
    },
    researchPortfolioEvent: {
      create: async ({ data }: any) => {
        portfolioEvents.push(data);
        return data;
      },
    },
    defenseSavedComparison: {
      findFirst: async ({ where }: any) => {
        const row = parents.find((row) => match(row, where));
        return row
          ? { ...row, currentVersion: versions.find((v) => v.id === row.currentVersionId) ?? null }
          : null;
      },
      findMany: async () => parents,
      create: async ({ data }: any) => {
        const row = { ...data, revision: 1, archivedAt: null, currentVersion: null };
        parents.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const row = parents.find((row) => match(row, where));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    defenseSavedComparisonVersion: {
      create: async ({ data }: any) => {
        versions.push(data);
        return data;
      },
      findFirst: async ({ where }: any) => versions.find((row) => match(row, where)) ?? null,
    },
    defenseSavedComparisonEvent: {
      create: async ({ data }: any) => {
        const row = { ...data, id: 'event-' + events.length };
        events.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => events.find((row) => match(row, where)) ?? null,
    },
  };
  const research: any = {
    compare: async (_subjects: any, options: any) => {
      readCalls++;
      calls.push(['compare', options]);
      return {
        projectionVersion: 'defense-comparison-v1',
        subjects: input().subjects.map((s) => ({
          ...s,
          key: s.type + ':' + s.id,
          label: s.id,
          availability: 'available',
        })),
        metrics: [
          {
            key: 'PB26|2026|request|funding|usd_millions|USD|unknown-price-basis',
            label: 'request',
            metric: 'funding',
            period: 'FY2026',
            unit: 'usd_millions',
            grain: 'subject',
            cells: input().subjects.map((s) => ({
              subjectKey: s.type + ':' + s.id,
              value: sourceValue,
              disposition: 'observed',
              reason: null,
              evidence: [],
            })),
          },
        ],
        alignments: [],
        limitations: [],
      };
    },
  };
  const service = new DefenseSavedComparisonsService(
    { withTenant: async (_tenant: any, fn: any) => fn(tx) } as any,
    research,
  );
  return {
    service,
    tx,
    parents,
    versions,
    events,
    calls,
    research,
    members,
    bookmarks,
    portfolioEvents,
    setMember: (value: boolean) => (member = value),
    setGrant: (value: boolean) => (grant = value),
    setPortfolio: (lifecycle: string, role: string) => {
      portfolioLifecycle = lifecycle;
      portfolioRole = role;
    },
    setSource: (value: string) => (sourceValue = value),
    getReadCalls: () => readCalls,
  };
}
describe('saved Defense Compare ownership and immutable server capture', () => {
  test('creates server-computed observed zero and reopens the same capture after live data changes', async () => {
    const f = fixture(),
      result = await f.service.save(ctx, input());
    expect(result.comparison.currentVersion.capturedProjection.metrics[0]?.cells[0]?.value).toBe(
      '0',
    );
    expect(result.comparison.currentVersion.captureKnownAt).toBe(
      result.comparison.currentVersion.capturedAt,
    );
    expect(result.comparison.currentVersion.knownAtSupport).toBe('capture_only');
    f.setSource('99');
    const reopened = await f.service.get(ctx, result.comparison.id);
    expect(reopened.currentVersion.contentHash).toBe(result.comparison.currentVersion.contentHash);
    expect(reopened.currentVersion.capturedProjection.metrics[0]?.cells[0]?.value).toBe('0');
    expect(f.getReadCalls()).toBe(2);
  });
  test('explicit empty selection remains empty while missing selection and client projections reject', async () => {
    const f = fixture(),
      empty = {
        ...input(),
        selection: { mode: 'explicit' as const, subjectKeys: [], passageIds: [] },
      };
    const result = await f.service.save(ctx, empty);
    expect(result.comparison.currentVersion.capturedProjection.subjects).toEqual([]);
    expect(result.comparison.currentVersion.capturedProjection.metrics).toEqual([]);
    await expect(f.service.save(ctx, { ...input(), selection: undefined } as any)).rejects.toThrow(
      'Explicit',
    );
    await expect(
      f.service.save(ctx, { ...input(), capturedProjection: {} } as any),
    ).rejects.toThrow('server generated');
    await expect(f.service.save(ctx, { ...input(), knownAt: '2000-01-01' } as any)).rejects.toThrow(
      'server generated',
    );
  });
  test('authorizes active membership and original owner before receipt replay or version disclosure', async () => {
    const f = fixture(),
      result = await f.service.save(ctx, input());
    f.setMember(false);
    await expect(f.service.save(ctx, input())).rejects.toThrow('Active tenant');
    f.setMember(true);
    await expect(
      f.service.get(
        { ...ctx, userId: '33333333-3333-4333-8333-333333333333' },
        result.comparison.id,
      ),
    ).rejects.toThrow('not found');
    await expect(
      f.service.get(
        { ...ctx, tenantId: '44444444-4444-4444-8444-444444444444' },
        result.comparison.id,
        result.comparison.currentVersion.id,
      ),
    ).rejects.toThrow('not found');
    expect(f.versions).toHaveLength(1);
  });
  test('requires current attached portfolio grant on reads and replay even for original owner', async () => {
    const f = fixture(),
      data = { ...input(), portfolioId: '55555555-5555-4555-8555-555555555555' };
    const result = await f.service.save(ctx, data);
    f.setGrant(false);
    await expect(f.service.get(ctx, result.comparison.id)).rejects.toThrow('portfolio');
    await expect(f.service.save(ctx, data)).rejects.toThrow('portfolio');
  });
  test('idempotent replay adds no versions, changed input and stale revision conflict', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, input()),
      replay = await f.service.save(ctx, input());
    expect(replay.replayed).toBe(true);
    expect(replay.eventId).toBe(first.eventId);
    expect(f.versions).toHaveLength(1);
    await expect(f.service.save(ctx, { ...input(), name: 'changed' })).rejects.toThrow(
      'different content',
    );
    await expect(
      f.service.save(
        ctx,
        { ...input(), idempotencyKey: 'revise-1', expectedRevision: 9 },
        first.comparison.id,
      ),
    ).rejects.toThrow('stale');
  });
  test('new version preserves old projection and old receipt metadata', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, input());
    f.setSource('7');
    const second = await f.service.save(
      ctx,
      { ...input(), name: 'Revision two', idempotencyKey: 'revise-2', expectedRevision: 1 },
      first.comparison.id,
    );
    expect(second.comparison.currentVersion.version).toBe(2);
    expect(second.resultingRevision).toBe(2);
    const old = await f.service.get(ctx, first.comparison.id, first.comparison.currentVersion.id);
    expect(old.currentVersion.capturedProjection.metrics[0]?.cells[0]?.value).toBe('0');
    const replay = await f.service.save(ctx, input());
    expect(replay.comparison.name).toBe('Owned capture');
    expect(replay.resultingRevision).toBe(1);
  });
  test('source changes between server reads reject without persistence', async () => {
    const f = fixture(),
      original = f.research.compare;
    let count = 0;
    f.research.compare = async (...args: any[]) => {
      f.setSource(String(++count));
      return original(...args);
    };
    await expect(f.service.save(ctx, input())).rejects.toThrow('changed during capture');
    expect(f.parents).toHaveLength(0);
    expect(f.versions).toHaveLength(0);
  });
  test('unsupported execution periods and dissimilar bases persist without coercing funding cells', async () => {
    const f = fixture(),
      data = {
        ...input(),
        basisPair: {
          left: { ...basis, asOfDate: '2026-09-01' },
          right: { ...basis, unit: 'units' },
        },
      };
    const result = await f.service.save(ctx, data);
    expect(result.comparison.currentVersion.basisPair).toEqual(data.basisPair);
    expect(result.comparison.currentVersion.capturedProjection.metrics).toEqual([]);
  });
});

describe('saved capture recovery across portfolio lifecycle changes', () => {
  test('archived viewer retains old capture and same-key create/revise replay; fresh writes remain blocked', async () => {
    const f = fixture(),
      data = { ...input(), portfolioId: '55555555-5555-4555-8555-555555555555' };
    const first = await f.service.save(ctx, data);
    const revision = {
      ...data,
      name: 'Second snapshot',
      idempotencyKey: 'revise-archived',
      expectedRevision: 1,
    };
    const second = await f.service.save(ctx, revision, first.comparison.id);
    f.setPortfolio('archived', 'viewer');
    expect(
      (await f.service.get(ctx, first.comparison.id, first.comparison.currentVersion.id))
        .currentVersion.id,
    ).toBe(first.comparison.currentVersion.id);
    const createReplay = await f.service.save(ctx, data);
    expect(createReplay.replayed).toBe(true);
    expect(createReplay.eventId).toBe(first.eventId);
    const revisionReplay = await f.service.save(ctx, revision, first.comparison.id);
    expect(revisionReplay.replayed).toBe(true);
    expect(revisionReplay.eventId).toBe(second.eventId);
    await expect(
      f.service.save(ctx, { ...data, idempotencyKey: 'fresh-after-archive' }),
    ).rejects.toThrow('active editable portfolio');
    await expect(
      f.service.save(
        ctx,
        { ...revision, idempotencyKey: 'new-revision-after-archive', expectedRevision: 2 },
        first.comparison.id,
      ),
    ).rejects.toThrow('active editable portfolio');
    expect(f.versions).toHaveLength(2);
  });
  test('archived read/replay never bypasses current grant, original owner, tenant or payload binding', async () => {
    const f = fixture(),
      data = { ...input(), portfolioId: '55555555-5555-4555-8555-555555555555' };
    const first = await f.service.save(ctx, data);
    f.setPortfolio('archived', 'viewer');
    await expect(f.service.save(ctx, { ...data, name: 'changed' })).rejects.toThrow(
      'different content',
    );
    await expect(
      f.service.get(
        { ...ctx, userId: '33333333-3333-4333-8333-333333333333' },
        first.comparison.id,
      ),
    ).rejects.toThrow('not found');
    await expect(
      f.service.get(
        { ...ctx, tenantId: '44444444-4444-4444-8444-444444444444' },
        first.comparison.id,
      ),
    ).rejects.toThrow('not found');
    f.setGrant(false);
    await expect(f.service.get(ctx, first.comparison.id)).rejects.toThrow('portfolio');
    await expect(f.service.save(ctx, data)).rejects.toThrow('portfolio');
    expect(f.versions).toHaveLength(1);
  });
  test('list permits archived attached portfolios only with the current principal grant', async () => {
    const f = fixture();
    let query: any;
    const original = f as any;
    // Inspect the real list filter instead of making an always-returning fixture prove policy.
    const tx: any = {
      $executeRaw: async () => 1,
      tenantMembership: { findFirst: async () => ({ id: 'member' }) },
      defenseSavedComparison: {
        findMany: async (args: any) => {
          query = args.where;
          return [];
        },
      },
    };
    const service = new DefenseSavedComparisonsService(
      { withTenant: async (_tenant: any, fn: any) => fn(tx) } as any,
      f.research,
    );
    await service.list(ctx);
    expect(query.ownerUserId).toBe(ctx.userId);
    expect(query.tenantId).toBe(ctx.tenantId);
    expect(query.OR[1].portfolio).toEqual({ grants: { some: { principalUserId: ctx.userId } } });
  });
});

describe('saved comparison archive and explicit captured selection attachment', () => {
  const target = '55555555-5555-4555-8555-555555555555';
  test('archive/restore preserve capture and original historical receipts across subsequent lifecycle changes', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, input()),
      archiveInput = { expectedRevision: 1, idempotencyKey: 'archive-1' };
    const archived = await f.service.changeLifecycle(ctx, first.comparison.id, archiveInput, true);
    expect(archived.comparison.archivedAt).not.toBeNull();
    expect(archived.resultingRevision).toBe(2);
    expect(f.versions).toHaveLength(1);
    const restored = await f.service.changeLifecycle(
      ctx,
      first.comparison.id,
      { expectedRevision: 2, idempotencyKey: 'restore-1' },
      false,
    );
    expect(restored.comparison.archivedAt).toBeNull();
    expect(restored.resultingRevision).toBe(3);
    const replay = await f.service.changeLifecycle(ctx, first.comparison.id, archiveInput, true);
    expect(replay.replayed).toBe(true);
    expect(replay.eventId).toBe(archived.eventId);
    expect(replay.comparison.archivedAt).toBe(archived.comparison.archivedAt);
    expect((await f.service.save(ctx, input())).comparison.archivedAt).toBeNull();
    expect(f.versions).toHaveLength(1);
    expect(f.parents[0].archivedAt).toBeNull();
  });
  test('canonical public members add once; original actor/key replay retains exact capture and revisions', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, input());
    const action = {
      expectedRevision: 1,
      expectedPortfolioRevision: 1,
      portfolioId: target,
      idempotencyKey: 'attach-1',
      selection: input().selection,
    };
    const result = await f.service.addSelectionToPortfolio(
      ctx,
      first.comparison.id,
      first.comparison.currentVersion.id,
      action,
    );
    expect(result.outcomes.map((o) => o.kind)).toEqual(['member', 'member']);
    expect(result.portfolioRevision).toBe(2);
    expect(result.comparison.currentVersion.contentHash).toBe(
      first.comparison.currentVersion.contentHash,
    );
    expect(f.members).toHaveLength(2);
    expect(f.bookmarks).toHaveLength(0);
    const event = f.portfolioEvents[0];
    expect(event.payload.publicMemberLineage.map((item: any) => item.subjectKey)).toEqual(
      action.selection.subjectKeys,
    );
    expect(event.payload.counts.membersCreated).toBe(2);
    expect(event.payload.versionId).toBeUndefined();
    expect(event.payload.comparisonId).toBeUndefined();
    expect(event.payload.selection).toBeUndefined();
    const privateEvent = f.events[1];
    expect(privateEvent.versionId).toBe(first.comparison.currentVersion.id);
    expect(privateEvent.payload.contentHash).toBe(first.comparison.currentVersion.contentHash);
    expect(privateEvent.payload.selection).toEqual(action.selection);
    const retry = await f.service.addSelectionToPortfolio(
      ctx,
      first.comparison.id,
      first.comparison.currentVersion.id,
      action,
    );
    expect(retry.replayed).toBe(true);
    expect(retry.eventId).toBe(result.eventId);
    expect(retry.outcomes).toEqual(result.outcomes);
    expect(f.members).toHaveLength(2);
    expect(f.portfolioEvents).toHaveLength(1);
  });
  test('empty selection adds nothing; unretained selections and stale revisions reject', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, input()),
      action = {
        expectedRevision: 1,
        expectedPortfolioRevision: 1,
        portfolioId: target,
        idempotencyKey: 'attach-empty',
        selection: { mode: 'explicit' as const, subjectKeys: [], passageIds: [] },
      };
    await expect(
      f.service.addSelectionToPortfolio(
        ctx,
        first.comparison.id,
        first.comparison.currentVersion.id,
        { ...action, selection: { ...action.selection, subjectKeys: ['program_element:unknown'] } },
      ),
    ).rejects.toThrow('explicitly retained');
    await expect(
      f.service.addSelectionToPortfolio(
        ctx,
        first.comparison.id,
        first.comparison.currentVersion.id,
        { ...action, expectedPortfolioRevision: 99 },
      ),
    ).rejects.toThrow('revision is stale');
    const result = await f.service.addSelectionToPortfolio(
      ctx,
      first.comparison.id,
      first.comparison.currentVersion.id,
      action,
    );
    expect(result.outcomes).toEqual([]);
    expect(f.members).toEqual([]);
    expect(f.bookmarks).toEqual([]);
    expect(f.versions).toHaveLength(1);
  });
  test('current target authority and archived read-only boundary checked even before receipt replay', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, input()),
      action = {
        expectedRevision: 1,
        expectedPortfolioRevision: 1,
        portfolioId: target,
        idempotencyKey: 'attach-auth',
        selection: input().selection,
      };
    f.setPortfolio('active', 'viewer');
    await expect(
      f.service.addSelectionToPortfolio(
        ctx,
        first.comparison.id,
        first.comparison.currentVersion.id,
        action,
      ),
    ).rejects.toThrow('editable target');
    expect(f.members).toEqual([]);
    f.setPortfolio('active', 'owner');
    await f.service.addSelectionToPortfolio(
      ctx,
      first.comparison.id,
      first.comparison.currentVersion.id,
      action,
    );
    f.setPortfolio('archived', 'viewer');
    expect(
      (
        await f.service.addSelectionToPortfolio(
          ctx,
          first.comparison.id,
          first.comparison.currentVersion.id,
          action,
        )
      ).replayed,
    ).toBe(true);
    f.setGrant(false);
    await expect(
      f.service.addSelectionToPortfolio(
        ctx,
        first.comparison.id,
        first.comparison.currentVersion.id,
        action,
      ),
    ).rejects.toThrow('portfolio');
  });
  test('existing excluded/candidate/unresolved member decisions are never reinstated by selection', async () => {
    for (const disposition of ['excluded', 'candidate', 'unresolved']) {
      const f = fixture(),
        first = await f.service.save(ctx, input());
      f.members.push({
        id: 'decided-member',
        tenantId: ctx.tenantId,
        portfolioId: target,
        targetKind: 'program_element',
        targetId: '0600000A',
        disposition,
      });
      await expect(
        f.service.addSelectionToPortfolio(
          ctx,
          first.comparison.id,
          first.comparison.currentVersion.id,
          {
            expectedRevision: 1,
            expectedPortfolioRevision: 1,
            portfolioId: target,
            idempotencyKey: 'attach-' + disposition,
            selection: input().selection,
          },
        ),
      ).rejects.toThrow('portfolio decision');
      expect(f.members[0].disposition).toBe(disposition);
      expect(f.portfolioEvents).toHaveLength(0);
    }
  });
});

test('context subject and selected passage bookmarks retain exact immutable captured revision and lineage', async () => {
  const f = fixture(),
    docs = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'],
    sections = ['88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999'],
    revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const subjects = docs.map((id) => ({ type: 'context_document' as const, id })),
    selection = {
      mode: 'explicit' as const,
      subjectKeys: docs.map((id) => 'context_document:' + id),
      passageIds: sections,
    };
  const data = {
    ...input(),
    subjects,
    selection,
    passageMode: 'native_sections' as const,
    contextualRevisionPins: docs.map((documentId, i) => ({
      documentId,
      revisionId: revision,
      sectionIds: [sections[i]!],
    })),
  };
  f.research.compare = async () => ({
    projectionVersion: 'defense-comparison-v1',
    subjects: subjects.map((s) => ({
      ...s,
      key: s.type + ':' + s.id,
      label: 'Synthetic context',
      availability: 'available',
    })),
    metrics: [
      {
        key: 'passage|native',
        label: 'Native section',
        metric: 'passage',
        period: null,
        unit: null,
        grain: 'document revision',
        cells: subjects.map((s, i) => ({
          subjectKey: s.type + ':' + s.id,
          value: '0',
          disposition: 'incompatible',
          reason: 'partial',
          evidence: [
            {
              evidenceRefId: 'context-compare:' + sections[i],
              sourceRevisionId: revision,
              contentHash: 'a'.repeat(64),
              nativeLocator: { page: null, section: 'section 1', occurrenceId: null },
              edition: 'older',
              sourceDocumentId: null,
              sourceFamily: 'synthetic',
              publisher: 'Owned fixture',
              sourceUrl: 'https://example.invalid/fixture',
              observedAt: '2026-09-20T00:00:00Z',
            },
          ],
        })),
      },
    ],
    alignments: [],
    limitations: [],
  });
  const first = await f.service.save(ctx, data);
  const receipt = await f.service.addSelectionToPortfolio(
    ctx,
    first.comparison.id,
    first.comparison.currentVersion.id,
    {
      expectedRevision: 1,
      expectedPortfolioRevision: 1,
      portfolioId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'context-bookmarks',
      selection,
    },
  );
  expect(f.members).toHaveLength(0);
  expect(f.bookmarks).toHaveLength(4);
  expect(receipt.outcomes.every((o) => o.kind === 'bookmark')).toBe(true);
  for (const row of f.bookmarks) {
    const note = JSON.parse(row.note);
    expect(row.userId).toBe(ctx.userId);
    expect(note.versionId).toBe(first.comparison.currentVersion.id);
    expect(note.contentHash).toBe(first.comparison.currentVersion.contentHash);
  }
  const passage = JSON.parse(f.bookmarks[2].note);
  expect(passage.lineage.sourceRevisionId).toBe(revision);
  expect(passage.lineage.nativeLocator.section).toBe('section 1');
  expect(f.versions).toHaveLength(1);
});

describe('immutable server Research Portfolio scope for saved comparisons', () => {
  const a = '55555555-5555-4555-8555-555555555555',
    b = '66666666-6666-4666-8666-666666666666';
  test('scoped capture fills the server attachment and ordinary callers retain unscoped behavior', async () => {
    const f = fixture(),
      scope = { portfolioId: a },
      first = await f.service.save(ctx, input(), undefined, scope);
    expect(first.comparison.portfolioId).toBe(a);
    expect((await f.service.get(ctx, first.comparison.id, undefined, scope)).id).toBe(
      first.comparison.id,
    );
    await expect(
      f.service.get(ctx, first.comparison.id, undefined, { portfolioId: b }),
    ).rejects.toThrow('outside the current');
    const ordinary = await f.service.save(ctx, {
      ...input(),
      idempotencyKey: 'ordinary-unattached',
    });
    expect(ordinary.comparison.portfolioId).toBeNull();
    expect((await f.service.get(ctx, ordinary.comparison.id)).id).toBe(ordinary.comparison.id);
  });
  test('scope rejects explicit cross-portfolio capture or selection target before persistence', async () => {
    const f = fixture(),
      scope = { portfolioId: a };
    await expect(
      f.service.save(ctx, { ...input(), portfolioId: b }, undefined, scope),
    ).rejects.toThrow('must match');
    await expect(
      f.service.save(ctx, { ...input(), portfolioId: null }, undefined, scope),
    ).rejects.toThrow('must match');
    const first = await f.service.save(ctx, input(), undefined, scope);
    await expect(
      f.service.addSelectionToPortfolio(
        ctx,
        first.comparison.id,
        first.comparison.currentVersion.id,
        {
          expectedRevision: 1,
          expectedPortfolioRevision: 1,
          portfolioId: b,
          idempotencyKey: 'wrong-target',
          selection: input().selection,
        },
        scope,
      ),
    ).rejects.toThrow('must match');
    expect(f.versions).toHaveLength(1);
    expect(f.members).toHaveLength(0);
    expect(f.bookmarks).toHaveLength(0);
  });
  test('native mutations reject reattachment after an adapter preflight, despite ownership and grants to both portfolios', async () => {
    const f = fixture(),
      scope = { portfolioId: a },
      first = await f.service.save(ctx, input(), undefined, scope);
    await f.service.get(ctx, first.comparison.id, undefined, scope);
    f.parents[0].portfolioId = b;
    await expect(
      f.service.save(
        ctx,
        { ...input(), idempotencyKey: 'after-preflight-revise', expectedRevision: 1 },
        first.comparison.id,
        scope,
      ),
    ).rejects.toThrow('outside the current');
    await expect(
      f.service.changeLifecycle(
        ctx,
        first.comparison.id,
        { expectedRevision: 1, idempotencyKey: 'after-preflight-archive' },
        true,
        scope,
      ),
    ).rejects.toThrow('outside the current');
    await expect(
      f.service.addSelectionToPortfolio(
        ctx,
        first.comparison.id,
        first.comparison.currentVersion.id,
        {
          expectedRevision: 1,
          expectedPortfolioRevision: 1,
          portfolioId: a,
          idempotencyKey: 'after-preflight-add',
          selection: input().selection,
        },
        scope,
      ),
    ).rejects.toThrow('outside the current');
    expect(f.versions).toHaveLength(1);
    expect(f.events).toHaveLength(1);
    expect(f.members).toHaveLength(0);
  });
  test('scoped read rechecks actual saved parent after acquiring SHARE, and locks portfolio before parent', async () => {
    const f = fixture(),
      scope = { portfolioId: a },
      first = await f.service.save(ctx, input(), undefined, scope),
      original = f.tx.$executeRaw,
      sequence: string[] = [];
    f.tx.$executeRaw = async (...args: any[]) => {
      const sql = args[0].join('');
      if (sql.includes('FROM research_portfolios')) sequence.push('portfolio');
      if (sql.includes('FROM defense_saved_comparisons')) {
        sequence.push('saved-parent');
        f.parents[0].portfolioId = b;
      }
      return original(...args);
    };
    await expect(f.service.get(ctx, first.comparison.id, undefined, scope)).rejects.toThrow(
      'outside the current',
    );
    expect(sequence).toEqual(['portfolio', 'saved-parent']);
  });
  test('historical replay cannot disclose another attachment even when current saved parent matches scope', async () => {
    const f = fixture(),
      first = await f.service.save(ctx, { ...input(), portfolioId: b }),
      action = { expectedRevision: 1, idempotencyKey: 'old-archive-other-attachment' };
    await f.service.changeLifecycle(ctx, first.comparison.id, action, true);
    await f.service.changeLifecycle(
      ctx,
      first.comparison.id,
      { expectedRevision: 2, idempotencyKey: 'old-restore' },
      false,
    );
    await f.service.save(
      ctx,
      { ...input(), portfolioId: a, expectedRevision: 3, idempotencyKey: 'reattach-current' },
      first.comparison.id,
    );
    expect(f.parents[0].portfolioId).toBe(a);
    await expect(
      f.service.changeLifecycle(ctx, first.comparison.id, action, true, { portfolioId: a }),
    ).rejects.toThrow('outside the current');
    const ordinary = await f.service.changeLifecycle(ctx, first.comparison.id, action, true);
    expect(ordinary.replayed).toBe(true);
    expect(ordinary.comparison.portfolioId).toBe(b);
    expect(ordinary.resultingRevision).toBe(2);
  });
  test('server scope is captured immutably before awaits, and same-scope original retry remains exact', async () => {
    const f = fixture(),
      scope = { portfolioId: a },
      original = f.research.compare;
    f.research.compare = async (...args: any[]) => {
      scope.portfolioId = b;
      return original(...args);
    };
    const first = await f.service.save(ctx, input(), undefined, scope);
    expect(first.comparison.portfolioId).toBe(a);
    const replay = await f.service.save(ctx, input(), undefined, { portfolioId: a });
    expect(replay.replayed).toBe(true);
    expect(replay.eventId).toBe(first.eventId);
    expect(f.versions).toHaveLength(1);
  });
  test('scoped list filters same attached portfolio and existing grants before the limit', async () => {
    const f = fixture();
    let query: any;
    const tx: any = {
      $executeRaw: async () => 1,
      tenantMembership: { findFirst: async () => ({ id: 'member' }) },
      defenseSavedComparison: {
        findMany: async (args: any) => {
          query = args;
          return [];
        },
      },
    };
    const service = new DefenseSavedComparisonsService(
      { withTenant: async (_tenant: any, fn: any) => fn(tx) } as any,
      f.research,
    );
    await service.list(ctx, true, { portfolioId: a });
    expect(query.where.portfolioId).toBe(a);
    expect(query.where.ownerUserId).toBe(ctx.userId);
    expect(query.where.tenantId).toBe(ctx.tenantId);
    expect(query.where.OR[1].portfolio.grants.some.principalUserId).toBe(ctx.userId);
    expect(query.take).toBe(50);
  });
});
