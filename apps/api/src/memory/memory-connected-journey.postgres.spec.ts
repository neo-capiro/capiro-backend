import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { settingsSubmissionFixture } from './settings-drafts/submission.postgres-fixture.js';
import { ownerRetentionCase } from './memory-owner-retention.postgres-fixture.js';
import { fileDefForType } from './memory-catalog.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryReviewNotificationDispatcherService } from './memory-review-notification-dispatcher.service.js';

// The provider is outside this ordinary-role database journey. Canonical
// publication, read eligibility and in-app notification delivery remain real.
jest.mock('./memory-embedding-lifecycle.js', () => ({
  embedMemoryItem: jest.fn(async () => ({ status: 'skipped' })),
}));
const url = process.env.MEMORY_CONNECTED_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'Connected Settings memory, review, recall and notifications',
  () => {
    let store: Awaited<ReturnType<typeof settingsSubmissionFixture>>;
    let context: TenantContextStore;
    let memory: MemoryStoreService;
    let dispatcher: MemoryReviewNotificationDispatcherService;
    const savedEnv = { ...process.env };
    beforeAll(async () => {
      process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
      process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
      process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
      process.env.MEMORY_CLIENT_REVIEW = 'enforce';
      store = await settingsSubmissionFixture(url!);
      context = new TenantContextStore();
      memory = new MemoryStoreService(store.prisma, context);
      dispatcher = new MemoryReviewNotificationDispatcherService(
        store.prisma,
        new MemoryAuthorizationService(store.prisma),
      );
    }, 60000);
    afterAll(async () => {
      await store?.db.$disconnect();
      process.env = savedEnv;
    });
    async function fixture() {
      const f = await ownerRetentionCase(store);
      const ctx = {
        tenantId: f.tenantId,
        userId: f.userId,
        role: 'user_admin',
        clerkUserId: 'owner-' + f.userId,
        tenantSlug: 'owner-' + f.tenantId,
      } as TenantContext;
      return { ...f, ctx };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function propose(f: Fixture, type: string, body: string) {
      const slug = type === 'user-profile' ? 'me' : type === 'client-soul' ? f.clientId : 'firm';
      const key = fileDefForType(type)!.sections[0]!.key;
      const base = await store.drafts.readFile(f.ctx, type, slug),
        id = randomUUID();
      await store.drafts.save(f.ctx, type, slug, id, {
        requestId: randomUUID(),
        expectedRevision: 0,
        action: 'save',
        baseItemId: base.baseItemId,
        baseVersion: base.baseVersion,
        sections: [{ key, body }],
      });
      const request = { requestId: randomUUID(), expectedRevision: 1 };
      const submitted = await store.submissions.submit(f.ctx, type, slug, id, request);
      return { ...submitted, id, type, slug, request };
    }
    const recall = (ctx: TenantContext) => context.run(ctx, () => memory.listForCurrentTenant());
    const recalledBodies = async (ctx: TenantContext) =>
      (await recall(ctx)).flatMap((item) => item.sections.map((section) => section.body));
    async function peer(f: Fixture) {
      const userId = randomUUID();
      await store.db.user.create({
        data: {
          id: userId,
          clerkUserId: 'peer-' + userId,
          email: userId + '@example.invalid',
        },
      });
      await store.db.tenantMembership.create({
        data: {
          tenantId: f.tenantId,
          userId,
          role: 'standard_user',
          status: 'active',
        },
      });
      return {
        ...f.ctx,
        userId,
        clerkUserId: 'peer-' + userId,
        role: 'standard_user',
      } as TenantContext;
    }

    it('never recalls pending/rejected personal content and exposes an exact approval only to its owner', async () => {
      const f = await fixture();
      const rejected = await propose(f, 'user-profile', 'Synthetic rejected preference');
      expect(await recall(f.ctx)).toEqual([]);
      await store.candidates.decideOwnPersonalCandidate(f.ctx, rejected.candidateId, 'reject');
      expect(await recall(f.ctx)).toEqual([]);
      const accepted = await propose(f, 'user-profile', 'Synthetic accepted preference');
      expect(await recall(f.ctx)).toEqual([]);
      const first = await store.candidates.decideOwnPersonalCandidate(
        f.ctx,
        accepted.candidateId,
        'approve',
      );
      expect(
        await store.candidates.decideOwnPersonalCandidate(f.ctx, accepted.candidateId, 'approve'),
      ).toEqual(first);
      expect(await recalledBodies(f.ctx)).toContain('Synthetic accepted preference');
      expect(await recalledBodies(f.ctx)).not.toContain('Synthetic rejected preference');
      expect(await recall(await peer(f))).toEqual([]);
      expect(await recall((await fixture()).ctx)).toEqual([]);
      expect(
        await store.submissions.receipt(
          f.ctx,
          accepted.type,
          accepted.slug,
          accepted.id,
          accepted.request.requestId,
        ),
      ).toEqual(expect.objectContaining({ candidateId: accepted.candidateId }));
    });

    it('keeps the active version through pending and rejected corrections, and recalls only the accepted replacement', async () => {
      const f = await fixture();
      const first = await propose(f, 'user-profile', 'Synthetic original preference');
      await store.candidates.decideOwnPersonalCandidate(f.ctx, first.candidateId, 'approve');
      const correction = await propose(f, 'user-profile', 'Synthetic corrected preference');
      expect(await recalledBodies(f.ctx)).toContain('Synthetic original preference');
      expect(await recalledBodies(f.ctx)).not.toContain('Synthetic corrected preference');
      const outcome = await store.immutable.approveCandidate(f.ctx, correction.candidateId);
      expect(await store.immutable.approveCandidate(f.ctx, correction.candidateId)).toEqual(
        outcome,
      );
      expect(await recall(f.ctx)).toHaveLength(1);
      expect(await recalledBodies(f.ctx)).toContain('Synthetic corrected preference');
      expect(await recalledBodies(f.ctx)).not.toContain('Synthetic original preference');
      const rejected = await propose(f, 'user-profile', 'Synthetic rejected correction');
      await store.immutable.rejectCandidate(
        f.ctx,
        rejected.candidateId,
        'Synthetic evidence rejected',
      );
      expect(await recalledBodies(f.ctx)).toContain('Synthetic corrected preference');
      expect(await recalledBodies(f.ctx)).not.toContain('Synthetic rejected correction');
    });

    it('delivers real review notifications, reconciles acknowledgements and follows firm publication into recall', async () => {
      const f = await fixture(),
        candidate = await propose(f, 'firm-soul', 'Synthetic reviewed firm statement');
      expect(await recall(f.ctx)).toEqual([]);
      await dispatcher.dispatchBatch(200);
      const notices = await store.inbox.listNotifications(f.ctx, { limit: 10 });
      expect(notices.items).toHaveLength(1);
      // The candidate trigger creates an unassigned workflow first; the current
      // notification contract records its later assignment as review_reassigned.
      expect(notices.items[0]).toMatchObject({
        candidateId: candidate.candidateId,
        eventType: 'review_reassigned',
      });
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({ enabled: true, count: 1 });
      expect(await store.inbox.detail(f.ctx, candidate.candidateId)).toMatchObject({
        status: 'pending',
      });
      await store.inbox.markNotificationRead(f.ctx, notices.items[0]!.id);
      await store.inbox.markNotificationRead(f.ctx, notices.items[0]!.id);
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({ enabled: true, count: 0 });
      const approved = await store.reviews.approve(f.ctx, candidate.candidateId);
      expect(await store.reviews.approve(f.ctx, candidate.candidateId)).toEqual(approved);
      expect(await store.inbox.detail(f.ctx, candidate.candidateId)).toMatchObject({
        status: 'approved',
      });
      await dispatcher.dispatchBatch(200);
      await dispatcher.dispatchBatch(200);
      const after = await store.inbox.listNotifications(f.ctx, { limit: 10 });
      expect(after.items.filter((n) => n.eventType === 'review_approved')).toHaveLength(1);
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({ enabled: true, count: 1 });
      expect(await recalledBodies(await peer(f))).toContain('Synthetic reviewed firm statement');
      expect(await store.inbox.markAllNotificationsRead(f.ctx)).toBe(1);
      expect(await store.inbox.markAllNotificationsRead(f.ctx)).toBe(0);
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({ enabled: true, count: 0 });
    });

    it.each(['reviews', 'notifications'] as const)(
      'pages through every %s record when database timestamps share microseconds',
      async (surface) => {
        const f = await fixture();
        const candidates = [];
        for (let n = 0; n < 3; n++) {
          candidates.push(await propose(f, 'firm-soul', `Synthetic page item ${n}`));
        }
        await dispatcher.dispatchBatch(200);
        await store.db.$executeRaw`
          UPDATE review_request SET created_at='2026-10-29T12:00:00.123456Z'::timestamptz
          WHERE tenant_id=${f.tenantId}::uuid`;
        await store.db.$executeRaw`
          UPDATE memory_review_in_app_notification SET created_at='2026-10-29T12:00:00.123456Z'::timestamptz
          WHERE tenant_id=${f.tenantId}::uuid`;
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
          const page: Awaited<
            ReturnType<typeof store.inbox.list | typeof store.inbox.listNotifications>
          > =
            surface === 'reviews'
              ? await store.inbox.list(f.ctx, { view: 'submitted_by_me', limit: 1, cursor })
              : await store.inbox.listNotifications(f.ctx, { limit: 1, cursor });
          seen.push(...page.items.map((item) => item.candidateId));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(cursor).toBeNull();
        expect(seen.sort()).toEqual(candidates.map((candidate) => candidate.candidateId).sort());
      },
    );

    it('counts and acknowledges all eligible notifications beyond the former 1,000-row cutoff', async () => {
      const f = await fixture(),
        seed = await propose(f, 'firm-soul', 'Synthetic volume fixture');
      const anotherRecipient = await peer(f);
      // Seed coherent persisted notifications in bulk through the real schema
      // and workflow triggers. Dispatch itself is covered by the journey above.
      await store.db.$executeRaw`
        INSERT INTO memory_candidate(tenant_id,proposed_by,source_kind,scope,payload_jsonb,provenance_jsonb)
        SELECT tenant_id,proposed_by,source_kind,scope,payload_jsonb,provenance_jsonb
        FROM memory_candidate CROSS JOIN generate_series(1,1001)
        WHERE id=${seed.candidateId}::uuid`;
      await store.db.$executeRaw`
        UPDATE review_request SET assigned_to=${f.userId}::uuid
        WHERE tenant_id=${f.tenantId}::uuid AND surface='memory'`;
      await store.db.$executeRaw`
        INSERT INTO memory_review_in_app_notification(tenant_id,recipient_user_id,review_request_id,
          candidate_id,event_type,title)
        SELECT tenant_id,${f.userId}::uuid,id,subject_id::uuid,'review_reassigned','Synthetic volume notification'
        FROM review_request WHERE tenant_id=${f.tenantId}::uuid AND surface='memory'`;
      await store.db.$executeRaw`
        INSERT INTO memory_review_in_app_notification(tenant_id,recipient_user_id,review_request_id,
          candidate_id,event_type,title)
        SELECT tenant_id,${anotherRecipient.userId}::uuid,id,subject_id::uuid,'review_reassigned','Synthetic other recipient'
        FROM review_request WHERE tenant_id=${f.tenantId}::uuid AND subject_id=${seed.candidateId}`;
      const blocked = await propose(f, 'client-soul', 'Synthetic restricted notification');
      await store.db.$executeRaw`
        INSERT INTO memory_review_in_app_notification(tenant_id,recipient_user_id,review_request_id,
          candidate_id,client_id,event_type,title)
        SELECT tenant_id,${f.userId}::uuid,id,subject_id::uuid,client_id,'review_reassigned','Synthetic restricted notification'
        FROM review_request WHERE tenant_id=${f.tenantId}::uuid AND subject_id=${blocked.candidateId}`;
      await store.db.client.update({ where: { id: f.clientId }, data: { memoryWall: true } });
      await store.db.$executeRaw`
        UPDATE memory_review_notification_outbox SET delivered_at=now()
        WHERE tenant_id=${f.tenantId}::uuid`;
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({
        enabled: true,
        count: 1002,
      });
      await store.db.$executeRaw`
        UPDATE memory_review_in_app_notification SET title='Synthetic last-page acknowledgement failure'
        WHERE id=(SELECT id FROM memory_review_in_app_notification
          WHERE tenant_id=${f.tenantId}::uuid AND recipient_user_id=${f.userId}::uuid
            AND client_id IS NULL ORDER BY id DESC LIMIT 1)`;
      await store.db.$executeRawUnsafe(
        "ALTER TABLE memory_review_in_app_notification ADD CONSTRAINT fixture_ack_unavailable CHECK(read_at IS NULL OR title <> 'Synthetic last-page acknowledgement failure') NOT VALID",
      );
      try {
        await expect(store.inbox.markAllNotificationsRead(f.ctx)).rejects.toThrow();
        const read = await store.db.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM memory_review_in_app_notification
          WHERE tenant_id=${f.tenantId}::uuid AND read_at IS NOT NULL`;
        expect(read).toEqual([{ count: 0 }]);
      } finally {
        await store.db.$executeRawUnsafe(
          'ALTER TABLE memory_review_in_app_notification DROP CONSTRAINT fixture_ack_unavailable',
        );
      }
      expect(await store.inbox.markAllNotificationsRead(f.ctx)).toBe(1002);
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({ enabled: true, count: 0 });
      expect(await store.inbox.markAllNotificationsRead(f.ctx)).toBe(0);
      expect(await store.inbox.unreadNotificationCount(anotherRecipient)).toEqual({
        enabled: true,
        count: 1,
      });
      const retained = await store.db.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM memory_review_in_app_notification
        WHERE tenant_id=${f.tenantId}::uuid AND read_at IS NULL`;
      expect(retained).toEqual([{ count: 2 }]);
    }, 60000);

    it('applies a changed client wall to recall, review links and notification reads, including an old acknowledgement', async () => {
      const f = await fixture(),
        candidate = await propose(f, 'client-soul', 'Synthetic client statement');
      await dispatcher.dispatchBatch(200);
      await store.reviews.approve(f.ctx, candidate.candidateId);
      await dispatcher.dispatchBatch(200);
      expect(await recalledBodies(f.ctx)).toContain('Synthetic client statement');
      const notice = (await store.inbox.listNotifications(f.ctx, { limit: 10 })).items[0]!;
      expect(notice).toBeDefined();
      await store.db.client.update({ where: { id: f.clientId }, data: { memoryWall: true } });
      expect(await recall(f.ctx)).toEqual([]);
      await expect(store.inbox.detail(f.ctx, candidate.candidateId)).rejects.toMatchObject({
        status: 404,
      });
      expect((await store.inbox.listNotifications(f.ctx, { limit: 10 })).items).toEqual([]);
      expect(await store.inbox.unreadNotificationCount(f.ctx)).toEqual({ enabled: true, count: 0 });
      await expect(store.inbox.markNotificationRead(f.ctx, notice.id)).rejects.toMatchObject({
        status: 404,
      });
    });
  },
);
