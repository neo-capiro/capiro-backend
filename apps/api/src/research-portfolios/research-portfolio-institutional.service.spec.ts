import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { ResearchPortfolioInstitutionalService } from './research-portfolio-institutional.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import {
  assertSavedMeetingPrepAccess,
  filterResearchPortfolioMeetingPreps,
} from '../engagement/meeting-prep-source-access.js';
const id = (n: number) => 'ed202609-2800-4000-8000-' + String(n).padStart(12, '0');
const ctx = { tenantId: id(9400), userId: id(9410) } as TenantContext;
function fixture() {
  let member = true,
    grant = true,
    meetingOwner = true,
    projectionStale = false,
    approved = false,
    sourceReads = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const bounded = {
    kind: 'research_portfolio',
    researchPortfolioId: id(9430),
    researchPortfolioName: 'Evidence portfolio',
    researchPortfolioRevision: 1,
  };
  const scope = {
    ...bounded,
    scopeVersion: createHash('sha256').update(JSON.stringify(bounded)).digest('hex'),
  };
  const conversation: any = {
    id: id(9440),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    metadata: { researchPortfolioScope: scope },
    archivedAt: null,
  };
  const portfolio: any = {
    id: id(9430),
    tenantId: ctx.tenantId,
    name: 'Evidence portfolio',
    purpose: 'Track public financial sources',
    revision: 1,
    lifecycle: 'active',
    grants: [{ role: 'viewer' }],
    clientLinks: [],
  };
  const review: any = {
    id: id(9450),
    tenantId: ctx.tenantId,
    portfolioId: portfolio.id,
    assigneeUserId: ctx.userId,
    status: 'open',
    revision: 3,
    targetKind: 'portfolio',
    targetId: portfolio.id,
    reason: 'Verify source coverage',
    evidenceFor: [{ sourceRevisionId: 'immutable-old' }],
    evidenceAgainst: [],
  };
  const artifacts: any[] = [],
    tasks: any[] = [],
    preps: any[] = [];
  const tx: any = {
    $executeRaw: async () => 1,
    tenantMembership: { findFirst: async () => (member ? { id: 'member' } : null) },
    researchPortfolio: { findFirst: async () => (grant ? portfolio : null) },
    clioConversation: {
      findFirst: async ({ where }: any) =>
        where.id === conversation.id &&
        where.tenantId === ctx.tenantId &&
        where.userId === ctx.userId
          ? conversation
          : null,
    },
    researchPortfolioReview: {
      findMany: async ({ where }: any) =>
        where.id.in.includes(review.id) &&
        review.assigneeUserId === where.assigneeUserId &&
        where.status.in.includes(review.status)
          ? [review]
          : [],
    },
    clioArtifact: {
      findFirst: async ({ where }: any) =>
        artifacts.find(
          (row) =>
            row.tenantId === where.tenantId &&
            row.userId === where.userId &&
            (where.id ? row.id === where.id : row.metadata.operationKey === where.metadata.equals),
        ),
      create: async ({ data }: any) => {
        const row = { ...data, id: id(9470 + artifacts.length), parentArtifactId: null };
        artifacts.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = artifacts.find((row) => row.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    engagementTask: {
      findFirst: async ({ where }: any) =>
        tasks.find(
          (row) =>
            row.tenantId === where.tenantId &&
            row.sourceType === where.sourceType &&
            row.sourceId === where.sourceId,
        ),
      findUnique: async ({ where }: any) => tasks.find((row) => row.id === where.id),
      findMany: async () => tasks,
      create: async ({ data }: any) => {
        const row = { ...data, id: id(9480 + tasks.length), status: 'todo' };
        tasks.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = tasks.find((row) => row.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    meeting: { findFirst: async () => ({ id: id(9420), clientId: null, isInternal: true }) },
    meetingPrep: {
      findFirst: async ({ where }: any) =>
        where.id
          ? preps.find((row) => row.id === where.id)
          : approved
            ? { id: 'prior-approved' }
            : null,
      create: async ({ data }: any) => {
        const row = { ...data, id: id(9490 + preps.length) };
        preps.push(row);
        return row;
      },
    },
  };
  const prisma: any = {
    withTenant: async (_tenant: any, fn: any) => {
      const work = queue.then(() => fn(tx));
      queue = work.catch(() => undefined);
      return work;
    },
  };
  const engagement: any = {
    prisma,
    lockMeetingClientAssignment: async () => undefined,
    ensureOwnMeeting: async () => {
      if (!meetingOwner) throw Error('Meeting not found');
      return { id: id(9420), clientId: null };
    },
  };
  for (const name of [
    'createTask',
    'createOwnedResearchPortfolioTask',
    'assertOwnedResearchPortfolioMeeting',
    'createOwnedResearchPortfolioMeetingPrep',
  ])
    engagement[name] = (EngagementService.prototype as any)[name].bind(engagement);
  const projection: any = {
    portfolioId: portfolio.id,
    portfolioRevision: 1,
    calculationVersion: 'research-portfolio-analytics-v2',
    availability: 'partial',
    totals: [],
    contributions: [
      {
        contributionId: 'exact',
        memberId: id(9460),
        targetKind: 'program_element',
        targetId: '0600000A',
        label: 'Public PE',
        basis: { metric: 'budget_authority', unit: 'usd_millions', fiscalYear: 2027 },
        value: '0',
        disposition: 'included',
        sourceDisposition: 'partial',
        reason: 'PB only; enacted proof unavailable',
        sourceRevisionIds: ['immutable-old'],
        evidence: [{ sourceRevisionId: 'immutable-old', nativeLocator: 'table:1/row:5' }],
      },
    ],
    coverage: {
      eligibleMembers: 1,
      supportedMembers: 1,
      includedContributions: 1,
      excludedContributions: 0,
      overlapContributions: 0,
      unavailableMembers: 0,
    },
    limitations: ['Partial source qualification'],
    observedAt: '2026-09-28T00:00:00.000Z',
    readAt: '2026-09-28T01:00:00.000Z',
  };
  const analytics: any = {
    analytics: async () => {
      sourceReads++;
      if (projectionStale) portfolio.revision = 2;
      return projection;
    },
  };
  const service = new ResearchPortfolioInstitutionalService(prisma, analytics, engagement),
    input = {
      conversationId: conversation.id,
      operationKey: 'original-key',
      confirmed: true as const,
      kind: 'meeting' as const,
      meetingId: id(9420),
      selectedReviewIds: [review.id],
    };
  return {
    service,
    engagement,
    tx,
    ctx,
    input,
    artifacts,
    tasks,
    preps,
    portfolio,
    review,
    conversation,
    projection,
    setMember: (v: boolean) => (member = v),
    setGrant: (v: boolean) => (grant = v),
    setMeetingOwner: (v: boolean) => (meetingOwner = v),
    setStale: () => (projectionStale = true),
    setApproved: () => (approved = true),
    sourceReads: () => sourceReads,
  };
}
describe('provider-free private RP institutional preparations', () => {
  test('real canonical artifact/prep/task IDs retain partial zero and exact original source appendix, no reviewed/share/provider state', async () => {
    const f = fixture();
    const r = await f.service.prepare(ctx, f.input);
    expect(r.artifactId).toBe(f.artifacts[0].id);
    expect(r.meetingPrepId).toBe(f.preps[0].id);
    expect(r.taskIds).toEqual([f.tasks[0].id]);
    expect(r.sourceLineage.sourceRevisionIds).toEqual(['immutable-old']);
    expect(f.artifacts[0].bodyText).toContain('source partial');
    expect(f.artifacts[0].bodyText).toContain('table:1/row:5');
    expect(f.artifacts[0].metadata.sourceLineage.projection.contributions[0].value).toBe('0');
    expect(f.preps[0]).toMatchObject({
      status: 'edited',
      provider: null,
      model: null,
      sharedAt: null,
      editedByUserId: ctx.userId,
    });
    expect(f.tasks[0]).toMatchObject({
      ownerUserId: ctx.userId,
      createdByUserId: ctx.userId,
      sourceType: 'research_portfolio_action',
      clientId: null,
      meetingId: null,
    });
  });
  test('same original actor/key retry creates exactly one actual output set; changed payload conflicts', async () => {
    const f = fixture();
    const a = await f.service.prepare(ctx, f.input),
      b = await f.service.prepare(ctx, f.input);
    expect(b.artifactId).toBe(a.artifactId);
    expect(b.replayed).toBe(true);
    expect(f.sourceReads()).toBe(1);
    expect(f.artifacts).toHaveLength(1);
    expect(f.tasks).toHaveLength(1);
    expect(f.preps).toHaveLength(1);
    await expect(f.service.prepare(ctx, { ...f.input, selectedReviewIds: [] })).rejects.toThrow(
      'different content',
    );
  });
  test('concurrent original operation requests converge on one complete output set', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.prepare(ctx, f.input),
      f.service.prepare(ctx, f.input),
    ]);
    expect(results[0].artifactId).toBe(results[1].artifactId);
    expect(f.artifacts).toHaveLength(1);
    expect(f.tasks).toHaveLength(1);
    expect(f.preps).toHaveLength(1);
  });
  test('approved meeting prep is preserved; explicit native draft refuses to supersede it', async () => {
    const f = fixture();
    f.setApproved();
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('approved meeting preparation');
    expect(f.preps).toEqual([]);
  });
  test('empty explicit selection creates no tasks; brief creates only owner-private artifact', async () => {
    const f = fixture();
    const r = await f.service.prepare(ctx, {
      conversationId: f.input.conversationId,
      operationKey: 'brief-key',
      confirmed: true,
      kind: 'brief',
    });
    expect(r.taskIds).toEqual([]);
    expect(r.meetingPrepId).toBeNull();
    expect(f.artifacts).toHaveLength(1);
    expect(f.tasks).toEqual([]);
    expect(f.preps).toEqual([]);
  });
  test('current membership, original conversation owner, grant and internal meeting owner are required', async () => {
    const f = fixture();
    f.setMember(false);
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('Active tenant');
    f.setMember(true);
    f.setGrant(false);
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('portfolio');
    f.setGrant(true);
    await expect(f.service.prepare({ ...ctx, userId: id(9411) }, f.input)).rejects.toThrow(
      'conversation',
    );
    f.setMeetingOwner(false);
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('Meeting not found');
    expect(f.artifacts).toEqual([]);
  });
  test('unselected or foreign review cannot create tasks; stale projection fails before publication', async () => {
    let f = fixture();
    f.review.assigneeUserId = id(9411);
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('owned reviews');
    expect(f.artifacts).toEqual([]);
    f = fixture();
    f.setStale();
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('changed');
    expect(f.artifacts).toEqual([]);
  });
  test('archived portfolio permits authorized exact historical replay while fresh writes are blocked; revoked grant denies replay', async () => {
    const f = fixture();
    const first = await f.service.prepare(ctx, f.input);
    f.portfolio.lifecycle = 'archived';
    expect((await f.service.prepare(ctx, f.input)).artifactId).toBe(first.artifactId);
    await expect(f.service.prepare(ctx, { ...f.input, operationKey: 'fresh-key' })).rejects.toThrow(
      'read only',
    );
    f.setGrant(false);
    await expect(f.service.prepare(ctx, f.input)).rejects.toThrow('portfolio');
  });
  test('private source tasks omit whole row on grant/member/owner denial; assignment remains creator-only; ordinary task behavior stays unchanged', async () => {
    const f = fixture();
    await f.service.prepare(ctx, f.input);
    const ordinary = {
      id: id(9489),
      tenantId: ctx.tenantId,
      sourceType: null,
      title: 'Ordinary task',
    };
    f.tasks.push(ordinary);
    expect(await EngagementService.prototype.listTasks.call(f.engagement, ctx, {})).toHaveLength(2);
    f.setGrant(false);
    expect(await EngagementService.prototype.listTasks.call(f.engagement, ctx, {})).toEqual([
      ordinary,
    ]);
    await expect(
      EngagementService.prototype.updateTask.call(f.engagement, ctx, f.tasks[0].id, {
        title: 'edit',
      }),
    ).rejects.toThrow('portfolio');
    f.setGrant(true);
    await expect(
      EngagementService.prototype.updateTask.call(f.engagement, ctx, f.tasks[0].id, {
        ownerUserId: id(9411),
      }),
    ).rejects.toThrow('remain owned');
    const edited = await EngagementService.prototype.updateTask.call(
      f.engagement,
      ctx,
      f.tasks[0].id,
      { title: 'Editable working task' },
    );
    expect(edited.title).toBe('Editable working task');
  });
  test('RP prep explicit and joined reads require current private artifact authority; ordinary provenance unchanged', async () => {
    const f = fixture();
    await f.service.prepare(ctx, f.input);
    const ordinary = { id: 'ordinary', summary: 'Ordinary preparation', generatedFrom: {} };
    await assertSavedMeetingPrepAccess(f.tx, ctx, f.preps[0].generatedFrom);
    expect(
      await filterResearchPortfolioMeetingPreps(f.tx, ctx, [...f.preps, ordinary]),
    ).toHaveLength(2);
    f.setGrant(false);
    await expect(assertSavedMeetingPrepAccess(f.tx, ctx, f.preps[0].generatedFrom)).rejects.toThrow(
      'portfolio',
    );
    expect(await filterResearchPortfolioMeetingPreps(f.tx, ctx, [...f.preps, ordinary])).toEqual([
      ordinary,
    ]);
    f.setGrant(true);
    f.setMember(false);
    expect(await filterResearchPortfolioMeetingPreps(f.tx, ctx, [...f.preps, ordinary])).toEqual([
      ordinary,
    ]);
  });
  test('confirmed true, exact server scope only and bounded unique selection are mandatory', async () => {
    const f = fixture();
    await expect(f.service.prepare(ctx, { ...f.input, confirmed: false } as any)).rejects.toThrow(
      'Explicit confirmation',
    );
    await expect(
      f.service.prepare(ctx, { ...f.input, portfolioId: id(9431) } as any),
    ).rejects.toThrow('Unknown');
    await expect(
      f.service.prepare(ctx, { ...f.input, selectedReviewIds: [f.review.id, f.review.id] }),
    ).rejects.toThrow('distinct');
    expect(f.artifacts).toEqual([]);
  });
});
