import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';
import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';
import { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import { isReadOnlyResearchPortfolioManagementInput } from './research-portfolio-management.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const portfolioId = '22222222-2222-4222-8222-222222222222';
const reviewId = '33333333-3333-4333-8333-333333333333';
const actor = '44444444-4444-4444-8444-444444444444';
const other = '55555555-5555-4555-8555-555555555555';
const ctx: any = { tenantId, userId: actor };
const at = new Date('2026-10-27T12:00:00Z');

function harness() {
  const portfolio: any = {
    id: portfolioId,
    revision: 7,
    lifecycle: 'active',
    grants: [{ role: 'editor' }],
    clientLinks: [],
  };
  const events: any[] = [],
    notes: any[] = [],
    bookmarks: any[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    // pg_advisory_xact_lock returns `void`; Prisma 5.22 cannot deserialize that
    // through $queryRaw (P2010), so production callers issue it through
    // $executeRaw. The mock must exist for those callers to be exercised.
    $executeRaw: jest.fn().mockResolvedValue(1),
    researchPortfolio: {
      findFirst: jest.fn(async () => portfolio),
      update: jest.fn(async () => ({ ...portfolio, revision: ++portfolio.revision })),
    },
    researchPortfolioReview: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === reviewId ? { id: reviewId, revision: 2 } : null,
      ),
    },
    researchPortfolioReviewNote: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `note-${notes.length}`, ...data, createdAt: at };
        notes.push(row);
        return row;
      }),
      findFirst: jest.fn(
        async ({ where }: any) => notes.find((row) => matches(row, where)) ?? null,
      ),
    },
    researchPortfolioEvent: {
      findFirst: jest.fn(
        async ({ where }: any) => events.find((row) => matches(row, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `event-${events.length}`, ...data, occurredAt: at };
        events.push(row);
        return row;
      }),
    },
    researchPortfolioBookmark: {
      findFirst: jest.fn(
        async ({ where }: any) => bookmarks.find((row) => matches(row, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `bookmark-${bookmarks.length}`, ...data, createdAt: at, updatedAt: at };
        bookmarks.push(row);
        return row;
      }),
    },
    researchPortfolioMember: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === reviewId ? { id: reviewId } : null,
      ),
      findMany: jest.fn(async () => []),
    },
    researchPortfolioRuleVersion: { findMany: jest.fn(async () => []) },
    researchPortfolioDecision: { findMany: jest.fn(async () => []) },
    researchPortfolioSnapshot: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'snapshot-created', ...data })),
    },
    researchPortfolioOutputRequest: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'request', ...data })),
    },
    researchPortfolioOutputJob: {
      create: jest.fn(async () => ({ id: 'job' })),
      findFirst: jest.fn(),
    },
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'membership' }) },
  };
  const prisma: any = {
    withTenant: async (_tenant: string, work: any) => work(tx),
    withTenantUser: async (_tenant: string, _actor: string, work: any) => work(tx),
  };
  return {
    tx,
    prisma,
    portfolio,
    events,
    notes,
    bookmarks,
    phase11: new ResearchPortfolioPhase11Service(prisma),
  };
}

// Prisma 5.22 refuses to decode a bare `void` column through $queryRaw (P2010). Core31
// (source 475053e) returned exactly this message for the bare
// `SELECT pg_advisory_xact_lock(...)` used as an operation lock, so every advisory-lock
// statement must go through $executeRaw.
function voidDeserializeError() {
  return new Error(
    "Failed to deserialize column of type 'void'. If you're using $queryRaw and this column is explicitly marked as `Unsupported` in your Prisma schema, try casting this column to any supported Prisma type such as `String`.",
  );
}

/** Make $queryRaw behave like the real driver for void-returning advisory-lock statements. */
function rejectVoidAdvisoryLock(h: any) {
  h.tx.$queryRaw.mockImplementation(async (sql: any) => {
    if (String(sql?.sql ?? sql).includes('pg_advisory_xact_lock')) throw voidDeserializeError();
    return [];
  });
}

describe('Research Portfolio closeout replay, lifecycle and role boundaries', () => {
  it('reads existing notes through the current portfolio and scoped review', async () => {
    const h = harness();
    const note = await h.phase11.addReviewNote(ctx, portfolioId, reviewId, { idempotencyKey: 'read-note', expectedRevision: 2, body: 'Visible note' });
    h.tx.researchPortfolioReviewNote.findMany = jest.fn(async () => h.notes);
    expect(await h.phase11.listReviewNotes(ctx, portfolioId, reviewId)).toEqual([note]);
    await expect(h.phase11.listReviewNotes(ctx, portfolioId, other)).rejects.toThrow('Review not found');
    h.tx.researchPortfolio.findFirst.mockResolvedValue(null);
    await expect(h.phase11.listReviewNotes(ctx, portfolioId, reviewId)).rejects.toThrow('portfolio not found');
    expect(h.tx.researchPortfolioReviewNote.findMany).toHaveBeenCalledTimes(1);
  });
  it('commits one note and receipt, replays the exact note, and rejects actor or body drift', async () => {
    const h = harness();
    const input = { idempotencyKey: 'note-key', expectedRevision: 2, body: 'Reviewed note' };
    const first = await h.phase11.addReviewNote(ctx, portfolioId, reviewId, input);
    expect(await h.phase11.addReviewNote(ctx, portfolioId, reviewId, input)).toEqual(first);
    await expect(
      h.phase11.addReviewNote({ ...ctx, userId: other }, portfolioId, reviewId, input),
    ).rejects.toThrow('different content');
    await expect(
      h.phase11.addReviewNote(ctx, portfolioId, reviewId, { ...input, body: 'Changed' }),
    ).rejects.toThrow('different content');
    expect(h.notes).toHaveLength(1);
    expect(h.events).toHaveLength(1);
    expect(h.portfolio.revision).toBe(8);
    // The note lock must be taken through $executeRaw: the bare advisory lock returns
    // `void`, which $queryRaw cannot deserialize (Prisma P2010).
    expect(
      h.tx.$executeRaw.mock.calls.some(([sql]: any[]) =>
        String(sql?.sql ?? sql).includes('pg_advisory_xact_lock'),
      ),
    ).toBe(true);
    expect(
      h.tx.$queryRaw.mock.calls.some(([sql]: any[]) =>
        String(sql?.sql ?? sql).includes('pg_advisory_xact_lock'),
      ),
    ).toBe(false);
  });
  it('refuses archived notes and stale review revisions without any note/event writes', async () => {
    const h = harness();
    const input = { idempotencyKey: 'note-key', expectedRevision: 1, body: 'Note' };
    await expect(h.phase11.addReviewNote(ctx, portfolioId, reviewId, input)).rejects.toThrow(
      'revision mismatch',
    );
    h.portfolio.lifecycle = 'archived';
    await expect(
      h.phase11.addReviewNote(ctx, portfolioId, reviewId, { ...input, expectedRevision: 2 }),
    ).rejects.toThrow('read-only');
    expect(h.notes).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });
  it('validates bookmark ownership and binds the replay key to the original content', async () => {
    const h = harness();
    const input = {
      idempotencyKey: 'bookmark-key',
      targetKind: 'member' as const,
      targetId: reviewId,
      label: 'Member',
    };
    const first = await h.phase11.createBookmark(ctx, portfolioId, input);
    expect(await h.phase11.createBookmark(ctx, portfolioId, input)).toEqual(first);
    await expect(
      h.phase11.createBookmark(ctx, portfolioId, { ...input, label: 'Changed' }),
    ).rejects.toThrow('different content');
    await expect(
      h.phase11.createBookmark({ ...ctx, userId: other }, portfolioId, input),
    ).rejects.toThrow('different content');
    await expect(
      h.phase11.createBookmark(ctx, portfolioId, {
        ...input,
        idempotencyKey: 'foreign',
        targetId: other,
      }),
    ).rejects.toThrow('target not found');
    expect(h.bookmarks).toHaveLength(1);
    expect(h.events[0].payload).toEqual({ operation: 'bookmark.create', created: true });
    expect(JSON.stringify(h.events[0].payload)).not.toContain(first.id);
    h.portfolio.lifecycle = 'archived';
    await expect(
      h.phase11.createBookmark(ctx, portfolioId, { ...input, idempotencyKey: 'new-on-archive' }),
    ).rejects.toThrow('read-only');
  });
  it('rejects malformed bookmark/tour values before a database write', async () => {
    const h = harness();
    await expect(
      h.phase11.createBookmark(ctx, portfolioId, {
        idempotencyKey: 'bad',
        targetKind: 'invented',
        targetId: reviewId,
      } as any),
    ).rejects.toThrow('supported target');
    await expect(h.phase11.updateTourState(ctx, 'v1', 'invented' as any)).rejects.toThrow(
      'Tour status',
    );
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('uses canonical public evidence resolution for evidence bookmarks', async () => {
    const h = harness();
    const evidence: any = {
      resolveEvidence: jest.fn(async (id: string) => ({
        evidenceRefId: id,
        availability: 'available',
      })),
    };
    const service = new ResearchPortfolioPhase11Service(h.prisma, undefined, evidence);
    await service.createBookmark(ctx, portfolioId, {
      idempotencyKey: 'evidence',
      targetKind: 'evidence',
      targetId: 'pe-position:' + reviewId,
    });
    expect(evidence.resolveEvidence).toHaveBeenCalledWith('pe-position:' + reviewId);
    evidence.resolveEvidence.mockResolvedValue({
      evidenceRefId: 'pe-position:' + other,
      availability: 'unavailable',
    });
    await expect(
      service.createBookmark(ctx, portfolioId, {
        idempotencyKey: 'denied',
        targetKind: 'evidence',
        targetId: 'pe-position:' + other,
      }),
    ).rejects.toThrow('evidence not found');
    expect(h.bookmarks).toHaveLength(1);
  });
  it('rejects archived snapshots and another actors snapshot replay', async () => {
    const h = harness();
    const service = new ResearchPortfolioAnalyticsService(h.prisma, {} as any);
    const input = { operationKey: 'snapshot', name: 'Frozen', expectedRevision: 7 };
    h.portfolio.lifecycle = 'archived';
    await expect(service.createSnapshot(ctx, portfolioId, input)).rejects.toThrow('read-only');
    h.tx.researchPortfolioSnapshot.findUnique.mockResolvedValue({
      portfolioId,
      name: input.name,
      portfolioRevision: 7,
      createdByUserId: other,
      basis: {},
    });
    await expect(service.createSnapshot(ctx, portfolioId, input)).rejects.toThrow(
      'different content',
    );
    expect(h.tx.researchPortfolioSnapshot.create).not.toHaveBeenCalled();
  });
  it('takes the snapshot operation lock without decoding the void advisory-lock result', async () => {
    const h = harness();
    // Core31 (source 475053e) failed POST /research-portfolios/:id/snapshots with
    // P2010 at research-portfolio-analytics.service.ts:104. Reproduce the driver so
    // the regression fails on the old raw-result form.
    rejectVoidAdvisoryLock(h);
    const service = new ResearchPortfolioAnalyticsService(h.prisma, {} as any);
    const result = await service.createSnapshot(ctx, portfolioId, {
      operationKey: 'void-lock',
      name: 'Frozen',
      expectedRevision: 7,
    });
    expect(result.name).toBe('Frozen');
    const lock = h.tx.$executeRaw.mock.calls.find(([sql]: any[]) =>
      String(sql?.sql ?? sql).includes('pg_advisory_xact_lock'),
    );
    expect(lock).toBeDefined();
    expect(String(lock![0].sql)).toContain('hashtextextended(');
    expect(
      h.tx.$queryRaw.mock.calls.some(([sql]: any[]) =>
        String(sql?.sql ?? sql).includes('pg_advisory_xact_lock'),
      ),
    ).toBe(false);
  });
  it('captures the first snapshot for an empty membership with an honest unavailable projection', async () => {
    const h = harness();
    const service = new ResearchPortfolioAnalyticsService(h.prisma, {} as any);
    const result = await service.createSnapshot(ctx, portfolioId, {
      operationKey: 'empty-first-snapshot',
      name: 'S1 16H 20261029 r1',
      expectedRevision: 7,
    });
    expect(result.name).toBe('S1 16H 20261029 r1');
    expect(result.portfolioRevision).toBe(7);
    expect(result.membership).toEqual([]);
    expect(result.basis).toEqual({});
    expect(result.projection.availability).toBe('unavailable');
    expect(result.projection.totals).toEqual([]);
    expect(result.projection.contributions).toEqual([]);
    expect(result.projection.coverage).toEqual({
      eligibleMembers: 0,
      supportedMembers: 0,
      includedContributions: 0,
      excludedContributions: 0,
      overlapContributions: 0,
      unavailableMembers: 0,
      notApplicableMembers: 0,
    });
    // No linked-client capability or fit prerequisite is added to capture.
    expect(result.clientAccessRequirements).toEqual([]);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.tx.researchPortfolioSnapshot.create).toHaveBeenCalledTimes(1);
    expect(h.tx.researchPortfolioMember.findMany).toHaveBeenCalledTimes(1);
  });
  it('creates a bookmark when the portfolio-event lock is taken without decoding void', async () => {
    const h = harness();
    rejectVoidAdvisoryLock(h);
    const bookmark = await h.phase11.createBookmark(ctx, portfolioId, {
      idempotencyKey: 'void-bookmark',
      targetKind: 'member' as const,
      targetId: reviewId,
      label: 'Member',
    });
    expect(bookmark.label).toBe('Member');
    expect(bookmark.targetId).toBe(reviewId);
    expect(h.bookmarks).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });
  it('adds a review note when the portfolio-event lock is taken without decoding void', async () => {
    const h = harness();
    rejectVoidAdvisoryLock(h);
    const note = await h.phase11.addReviewNote(ctx, portfolioId, reviewId, {
      idempotencyKey: 'void-note',
      expectedRevision: 2,
      body: 'Reviewed note',
    });
    expect(note.body).toBe('Reviewed note');
    expect(note.reviewId).toBe(reviewId);
    expect(h.notes).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });
  it('creates an output request when the output lock is taken without decoding void', async () => {
    const h = harness();
    rejectVoidAdvisoryLock(h);
    const service = new ResearchPortfolioOutputService(h.prisma, {} as any, {} as any);
    (service as any).process = jest.fn();
    service.get = jest.fn().mockResolvedValue({ id: 'job' } as any);
    await service.create(ctx, portfolioId, { operationKey: 'void-output', format: 'csv' as const });
    expect(h.tx.researchPortfolioOutputRequest.create).toHaveBeenCalledTimes(1);
    expect(
      h.tx.$queryRaw.mock.calls.some(([sql]: any[]) =>
        String(sql?.sql ?? sql).includes('pg_advisory_xact_lock'),
      ),
    ).toBe(false);
  });
  it('requires editor access for output effects and binds output replay to its actor', async () => {
    const h = harness();
    const service = new ResearchPortfolioOutputService(h.prisma, {} as any, {} as any);
    (service as any).process = jest.fn();
    service.get = jest.fn().mockResolvedValue({ id: 'job' } as any);
    const input = { operationKey: 'output', format: 'csv' as const };
    await service.create(ctx, portfolioId, input);
    const data = h.tx.researchPortfolioOutputRequest.create.mock.calls[0][0].data;
    h.tx.researchPortfolioOutputRequest.findUnique.mockResolvedValue({
      ...data,
      jobs: [{ id: 'job' }],
    });
    await expect(service.create({ ...ctx, userId: other }, portfolioId, input)).rejects.toThrow(
      'different content',
    );
    h.portfolio.grants[0].role = 'viewer';
    for (const operation of [
      () => service.create(ctx, portfolioId, input),
      () => service.cancel(ctx, portfolioId, 'job'),
      () => service.retry(ctx, portfolioId, 'job'),
      () => service.reconcile(ctx, portfolioId, 'job'),
      () =>
        service.saveToClient(ctx, portfolioId, 'artifact', {
          clientId: other,
          operationKey: 'file',
        }),
    ])
      await expect(operation()).rejects.toThrow('editor access required');
    expect(h.tx.researchPortfolioOutputJob.findFirst).not.toHaveBeenCalled();
  });
  it.each(['create', 'update'])(
    'resumes through %s with a fresh quiet baseline',
    async (method) => {
      const h = harness();
      const row = {
        id: 'subscription',
        tenantId,
        portfolioId,
        subscriberUserId: actor,
        active: false,
        targetKind: 'portfolio',
        targetId: portfolioId,
        channel: 'in_app',
        cadence: 'immediate',
        createdAt: at,
        updatedAt: at,
      };
      h.tx.researchPortfolioSubscription = {
        findFirst: jest.fn().mockResolvedValue(row),
        update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
      };
      h.tx.researchPortfolioEvent.findFirst.mockResolvedValue({
        id: 'latest',
        aggregateRevision: 7,
        occurredAt: at,
      });
      const service = new ResearchPortfolioChangesService(h.prisma);
      const result =
        method === 'create'
          ? await service.createSubscription(ctx, portfolioId, {
              targetKind: 'portfolio',
              targetId: portfolioId,
              channel: 'in_app',
              cadence: 'immediate',
            })
          : await service.updateSubscription(ctx, portfolioId, row.id, { active: true });
      expect(result).toMatchObject({
        active: true,
        baselineEventId: 'latest',
        baselineRevision: 7,
        checkpoint: { quietFirstBaseline: true, observedThrough: at.toISOString() },
      });
    },
  );
  it('classifies reads per validated management action and does not relax write confirmation', () => {
    expect(
      isReadOnlyResearchPortfolioManagementInput({
        conversationId: reviewId,
        action: 'members_list',
        parameters: {},
      }),
    ).toBe(true);
    expect(() =>
      isReadOnlyResearchPortfolioManagementInput({
        conversationId: reviewId,
        action: 'output_cancel',
        parameters: { jobId: other },
      }),
    ).toThrow('confirmed');
  });
});
