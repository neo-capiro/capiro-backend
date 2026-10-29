import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { AnalystLinkReviewService } from './analyst-link-review.service.js';
import { analystLinkDatabase } from './analyst-link-review.postgres-fixture.js';
import {
  LINK_REVIEW_ACTION,
  type LinkReviewInput,
  type LinkReviewKind,
} from './analyst-link-review.types.js';
import { persistMatches } from '../../../scripts/sync-sam-opportunities.js';

const url = process.env.IMPERSONATION_TEST_DATABASE_URL;
(url ? describe : describe.skip)('canonical analyst links through ordinary PostgreSQL', () => {
  let store: Awaited<ReturnType<typeof analystLinkDatabase>>, service: AnalystLinkReviewService;
  let ctx: TenantContext, checks: number, revokedAfter: number;
  let programId: string,
    peCode: string,
    documentId: string,
    provisionId: string,
    opportunityId: string;
  let provisionLink: string, samLink: string;
  const req = { header: () => undefined } as unknown as Request;
  beforeAll(async () => {
    store = await analystLinkDatabase(url!);
  }, 90000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  beforeEach(async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    ctx = {
      tenantId,
      userId,
      clerkUserId: 'synthetic-' + userId,
      tenantSlug: 'synthetic-' + tenantId,
      role: 'capiro_admin',
    };
    await store.db.tenant.create({
      data: { id: tenantId, slug: ctx.tenantSlug!, name: 'Synthetic HQ', status: 'active' },
    });
    await store.db.user.create({
      data: { id: userId, clerkUserId: ctx.clerkUserId, email: userId + '@example.invalid' },
    });
    await store.db.tenantMembership.create({
      data: { tenantId, userId, role: 'capiro_admin', status: 'active' },
    });
    programId = (
      await store.db.program.create({ data: { canonicalName: 'Synthetic test program' } })
    ).id;
    peCode = randomUUID().slice(0, 16);
    await store.db.programElement.create({
      data: { peCode, title: 'Synthetic PE', source: 'synthetic-fixture' },
    });
    documentId = (
      await store.db.sourceDocument.create({
        data: {
          sourceKey: randomUUID(),
          title: 'Synthetic report',
          sourceUrl: 'https://example.invalid/report',
          budgetCycle: 'hasc',
          documentType: 'committee_report',
          extractionMethod: 'manual',
        },
      })
    ).id;
    provisionId = (
      await store.db.committeeReportProvision.create({
        data: {
          sourceDocumentId: documentId,
          committee: 'HASC',
          fy: 2027,
          heading: 'Synthetic heading',
          text: 'Synthetic source evidence',
          pageStart: 2,
          pageEnd: 3,
        },
      })
    ).id;
    opportunityId = (
      await store.db.samOpportunity.create({
        data: {
          noticeId: randomUUID(),
          title: 'Synthetic notice',
          noticeType: 'Sources Sought',
          description: 'Synthetic SAM evidence',
          sourceUrl: 'https://example.invalid/notice',
        },
      })
    ).id;
    provisionLink = (
      await store.db.provisionPeLink.create({
        data: { provisionId, peCode, programId, matchBasis: 'program_alias' },
      })
    ).id;
    samLink = (
      await store.db.samOpportunityMatch.create({
        data: { opportunityId, peCode, programId, matchBasis: 'program_alias' },
      })
    ).id;
    checks = 0;
    revokedAfter = Infinity;
    service = new AnalystLinkReviewService(store.system, {
      readApplicationAuthoritySession: async () => ({
        readCurrent: async () => {
          if (++checks > revokedAfter) throw new ForbiddenException('Session revoked');
        },
      }),
    } as never);
  });
  afterEach(async () => {
    // Only records allocated by this test; source parents cascade to owned links.
    await store.db.committeeReportProvision.deleteMany({ where: { id: provisionId } });
    await store.db.samOpportunity.deleteMany({ where: { id: opportunityId } });
    await store.db.sourceDocument.deleteMany({ where: { id: documentId } });
    await store.db.program.deleteMany({ where: { id: programId } });
    await store.db.programElement.deleteMany({ where: { peCode } });
  });
  const idFor = (kind: LinkReviewKind) => (kind === 'sam' ? samLink : provisionLink);
  const detail = (kind: LinkReviewKind) => service.detail(ctx, req, kind, idFor(kind));
  async function input(
    kind: LinkReviewKind,
    decision: 'accept' | 'reject' = 'accept',
  ): Promise<LinkReviewInput> {
    return {
      requestId: randomUUID(),
      expectedVersion: (await detail(kind)).candidate.version,
      decision,
      reason: 'Reviewed the synthetic source and target',
    };
  }
  const decide = (kind: LinkReviewKind, body: LinkReviewInput) =>
    service.decide(ctx, req, kind, idFor(kind), body);
  const audits = () =>
    store.db.auditLog.findMany({ where: { actorUserId: ctx.userId, action: LINK_REVIEW_ACTION } });

  it.each(['provision', 'sam'] as const)(
    'atomically decides %s, recovers exact receipt and preserves unrelated rows',
    async (kind) => {
      const other = kind === 'sam' ? 'provision' : 'sam';
      const untouched = (await detail(other)).candidate;
      const command = await input(kind);
      const result = await decide(kind, command);
      expect(result.receipt).toMatchObject({
        requestId: command.requestId,
        kind,
        candidateId: idFor(kind),
        expectedVersion: command.expectedVersion,
        status: 'accepted',
        reviewerId: ctx.userId,
        reason: command.reason,
      });
      expect(result.receipt.resultingVersion).not.toBe(command.expectedVersion);
      expect(await decide(kind, command)).toEqual({ ...result, replayed: true });
      expect((await service.receipt(ctx, req, command.requestId)).receipt).toEqual(result.receipt);
      expect((await detail(kind)).lastReview).toEqual(result.receipt);
      expect((await detail(kind)).candidate.reviewStatus).toBe('accepted');
      expect((await detail(other)).candidate).toEqual(untouched);
      expect(await audits()).toHaveLength(1);
      await expect(decide(kind, { ...command, reason: 'Changed request' })).rejects.toThrow(
        'REVIEW_REQUEST_CONFLICT',
      );
    },
  );
  it.each(['provision', 'sam'] as const)(
    'serializes duplicate and competing %s decisions',
    async (kind) => {
      const command = await input(kind, 'reject');
      const results = await Promise.all([decide(kind, command), decide(kind, command)]);
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(
        (await decide(kind, { ...command, requestId: randomUUID(), decision: 'accept' })).receipt
          .refusal,
      ).toBe('REVIEW_SOURCE_STALE');
      expect(await audits()).toHaveLength(2);
    },
  );
  it('allows exactly one winner when two reviewers decide the same evidence', async () => {
    const command = await input('sam');
    const result = await Promise.all([
      decide('sam', command),
      decide('sam', { ...command, requestId: randomUUID(), decision: 'reject' }),
    ]);
    expect(result.filter((r) => r.receipt.status !== 'refused')).toHaveLength(1);
    expect(result.filter((r) => r.receipt.status === 'refused')).toHaveLength(1);
    expect(await audits()).toHaveLength(2);
  });
  it.each(['provision', 'document', 'sam', 'program', 'pe', 'candidate'] as const)(
    'refuses changed %s evidence',
    async (owner) => {
      const kind = owner === 'sam' ? 'sam' : 'provision';
      const command = await input(kind);
      if (owner === 'provision')
        await store.db.committeeReportProvision.update({
          where: { id: provisionId },
          data: { text: 'Changed evidence' },
        });
      if (owner === 'document')
        await store.db.sourceDocument.update({
          where: { id: documentId },
          data: { sha256: 'a'.repeat(64) },
        });
      if (owner === 'sam')
        await store.db.samOpportunity.update({
          where: { id: opportunityId },
          data: { description: 'Changed evidence' },
        });
      if (owner === 'program')
        await store.db.program.update({
          where: { id: programId },
          data: { canonicalName: 'Changed target' },
        });
      if (owner === 'pe')
        await store.db.programElement.update({
          where: { peCode },
          data: { title: 'Changed target' },
        });
      if (owner === 'candidate')
        await store.db.provisionPeLink.update({
          where: { id: provisionLink },
          data: { confidence: 0.9 },
        });
      const result = await decide(kind, command);
      expect(result.receipt.refusal).toBe('REVIEW_SOURCE_STALE');
      expect(result.receipt.status).toBe('refused');
      expect((await decide(kind, command)).receipt).toEqual(result.receipt);
      expect((await detail(kind)).candidate.reviewStatus).toBe('candidate');
      expect(await audits()).toHaveLength(1);
    },
  );
  it('requires live target for acceptance but permits rejecting a broken match', async () => {
    await store.db.programElement.update({ where: { peCode }, data: { retiredAt: new Date() } });
    expect((await decide('sam', await input('sam'))).receipt.refusal).toBe(
      'REVIEW_TARGET_UNAVAILABLE',
    );
    expect((await decide('sam', await input('sam', 'reject'))).receipt.status).toBe('rejected');
  });
  it('pages each status deterministically and reports canonical counts', async () => {
    await store.db.samOpportunityMatch.update({
      where: { id: samLink },
      data: { reviewStatus: 'quarantined' },
    });
    const first = await service.list(ctx, req, 'sam', { status: 'quarantined', limit: 1 });
    expect(first.total).toBe(
      await store.db.samOpportunityMatch.count({ where: { reviewStatus: 'quarantined' } }),
    );
    expect(first.counts.quarantined).toBe(first.total);
    const all: string[] = [];
    for (let page = 1; page <= first.total; page++)
      all.push(
        ...(
          await service.list(ctx, req, 'sam', { status: 'quarantined', limit: 1, page })
        ).data.map((r) => r.id),
      );
    expect(new Set(all).size).toBe(first.total);
    expect(all).toContain(samLink);
    await decide('sam', await input('sam', 'reject'));
    expect((await service.list(ctx, req, 'sam', { status: 'quarantined' })).total).toBe(
      first.total - 1,
    );
    expect(() => service.list(ctx, req, 'provision', { status: 'quarantined' })).toThrow(
      'Invalid review page',
    );
  });
  it('rechecks canonical membership, refuses impersonation and rolls back a revoked session', async () => {
    const command = await input('provision');
    await expect(
      service.list({ ...ctx, role: 'user_admin' }, req, 'provision', {}),
    ).rejects.toThrow('HQ');
    await expect(
      service.list(ctx, { header: () => 'synthetic' } as unknown as Request, 'provision', {}),
    ).rejects.toThrow('HQ');
    await store.db.tenantMembership.update({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
      data: { status: 'removed' },
    });
    await expect(decide('provision', command)).rejects.toThrow('access denied');
    await store.db.tenantMembership.update({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
      data: { status: 'active' },
    });
    revokedAfter = checks + 1;
    await expect(decide('provision', command)).rejects.toThrow('Session revoked');
    expect(
      (await store.db.provisionPeLink.findUniqueOrThrow({ where: { id: provisionLink } }))
        .reviewStatus,
    ).toBe('candidate');
    expect(await audits()).toHaveLength(0);
  });
  it('machine refresh cannot change a newly accepted match after its earlier read', async () => {
    const command = await input('sam');
    const stale = await store.db.samOpportunityMatch.findUniqueOrThrow({ where: { id: samLink } });
    await decide('sam', command);
    const client = {
      samOpportunityMatch: {
        findFirst: async () => stale,
        updateMany: store.db.samOpportunityMatch.updateMany.bind(store.db.samOpportunityMatch),
      },
    };
    expect(
      await persistMatches(client as never, opportunityId, [
        {
          programId,
          peCode,
          matchBasis: 'program_alias',
          confidence: 0.99,
          reviewStatus: 'candidate',
        },
      ]),
    ).toBe(0);
    expect((await detail('sam')).candidate.confidence).toBe(stale.confidence);
  });
});
