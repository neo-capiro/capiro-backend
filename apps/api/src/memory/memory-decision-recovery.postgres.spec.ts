import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { settingsSubmissionFixture } from './settings-drafts/submission.postgres-fixture.js';
import { ownerRetentionCase } from './memory-owner-retention.postgres-fixture.js';
import { fileDefForType } from './memory-catalog.js';
import { embedMemoryItem } from './memory-embedding-lifecycle.js';

jest.mock('./memory-embedding-lifecycle.js', () => ({
  embedMemoryItem: jest.fn(async () => ({ status: 'skipped' })),
}));
const url = process.env.MEMORY_DECISION_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Original memory decisions through canonical owners', () => {
  let store: Awaited<ReturnType<typeof settingsSubmissionFixture>>;
  const savedEnv = { ...process.env };
  beforeAll(async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_ENFORCE = 'enforce';
    process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
    process.env.MEMORY_CLIENT_REVIEW = 'enforce';
    store = await settingsSubmissionFixture(url!);
  }, 60000);
  afterAll(async () => {
    await store?.db.$disconnect();
    process.env = savedEnv;
  });

  async function proposal(type = 'user-profile', correction = false) {
    const f = await ownerRetentionCase(store),
      ctx = { ...f, role: 'user_admin' } as unknown as TenantContext;
    const slug = type === 'user-profile' ? 'me' : type === 'client-soul' ? f.clientId : 'firm';
    const key = fileDefForType(type)!.sections[0]!.key;
    const source = correction
      ? await store.scoped(f.tenantId, (tx) =>
          tx.memoryItem.create({
            data: {
              tenantId: f.tenantId,
              ownerUserId: type === 'user-profile' ? f.userId : null,
              visibility: type === 'user-profile' ? 'user' : 'tenant',
              memoryScope:
                type === 'user-profile'
                  ? 'user_private'
                  : type === 'client-soul'
                    ? 'client'
                    : 'firm',
              clientId: type === 'client-soul' ? f.clientId : null,
              memoryClass:
                type === 'user-profile'
                  ? 'user_preference'
                  : type === 'client-soul'
                    ? 'client_steering'
                    : 'institutional_authoritative',
              governedStatus: 'active',
              type,
              slug: type === 'user-profile' ? f.userId : slug,
              title: 'Synthetic decision source',
              source: 'manual',
              sections: [{ key, heading: 'Source', owner: 'human', body: 'Original content' }],
            },
          }),
        )
      : null;
    const base = await store.drafts.readFile(ctx, type, slug),
      id = randomUUID();
    await store.drafts.save(ctx, type, slug, id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      action: 'save',
      baseItemId: base.baseItemId,
      baseVersion: base.baseVersion,
      sections: [{ key, body: 'Exact reviewed replacement' }],
    });
    const submitted = await store.submissions.submit(ctx, type, slug, id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    });
    return { ...f, ctx, source, candidateId: submitted.candidateId };
  }
  const receiptCount = (tenantId: string, candidateId: string) =>
    store.db.memoryTransitionAudit.count({
      where: {
        tenantId,
        memoryCandidateId: candidateId,
        metadata: { path: ['decisionVersion'], equals: 1 },
      },
    });

  it('concurrent personal approvals return one original result and dispatch projection once', async () => {
    const f = await proposal(),
      before = store.projected();
    const results = await Promise.all(
      [0, 1].map(() =>
        store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve'),
      ),
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: 'approved', memoryId: expect.any(String) });
    expect(store.projected() - before).toBe(1);
    expect(await store.db.clioMemory.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await receiptCount(f.tenantId, f.candidateId)).toBe(1);
  });

  it('repeated personal rejection leaves content inactive and refuses the opposite decision', async () => {
    const f = await proposal();
    const first = await store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'reject');
    expect(
      await store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'reject'),
    ).toEqual(first);
    await expect(
      store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve'),
    ).rejects.toThrow('different disposition');
    expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await receiptCount(f.tenantId, f.candidateId)).toBe(1);
  });

  it('concurrent immutable approvals recover the exact original version without re-embedding', async () => {
    const f = await proposal('user-profile', true),
      before = jest.mocked(embedMemoryItem).mock.calls.length;
    const results = await Promise.all(
      [0, 1].map(() => store.immutable.approveCandidate(f.ctx, f.candidateId)),
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ outcome: 'activated', memoryItemId: expect.any(String) });
    expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(2);
    expect(jest.mocked(embedMemoryItem).mock.calls.length - before).toBe(1);
    await store.scoped(f.tenantId, (tx) =>
      tx.memoryItem.update({
        where: { id: results[0]!.memoryItemId! },
        data: { governedStatus: 'superseded' },
      }),
    );
    expect(await store.immutable.approveCandidate(f.ctx, f.candidateId)).toEqual(results[0]);
    expect(await receiptCount(f.tenantId, f.candidateId)).toBe(1);
  });

  it('immutable rejection retains its reason and refuses changed decision input', async () => {
    const f = await proposal('user-profile', true);
    const first = await store.immutable.rejectCandidate(f.ctx, f.candidateId, 'Wrong source');
    expect(await store.immutable.rejectCandidate(f.ctx, f.candidateId, 'Wrong source')).toEqual(
      first,
    );
    await expect(
      store.immutable.rejectCandidate(f.ctx, f.candidateId, 'Changed reason'),
    ).rejects.toThrow('different action or reason');
    expect(
      (await store.db.memoryItem.findUniqueOrThrow({ where: { id: f.source!.id } })).governedStatus,
    ).toBe('active');
  });

  it('shared review retries retain the first review timestamp and do not append audit events', async () => {
    const f = await proposal('client-soul');
    const first = await store.reviews.approve(f.ctx, f.candidateId);
    const request = await store.db.reviewRequest.findFirstOrThrow({
      where: { tenantId: f.tenantId, subjectId: f.candidateId },
    });
    const count = await store.db.auditLog.count({ where: { tenantId: f.tenantId } });
    expect(await store.reviews.approve(f.ctx, f.candidateId)).toEqual(first);
    expect(await store.db.reviewRequest.findUniqueOrThrow({ where: { id: request.id } })).toEqual(
      request,
    );
    expect(await store.db.auditLog.count({ where: { tenantId: f.tenantId } })).toBe(count);
  });

  it('recovers a committed shared rejection when its workflow acknowledgement was interrupted', async () => {
    const f = await proposal('client-soul');
    const complete = jest
      .spyOn(store.workflow, 'completeDecision')
      .mockRejectedValueOnce(new Error('Synthetic lost workflow acknowledgement'));
    await expect(store.reviews.reject(f.ctx, f.candidateId, 'Keep current memory')).rejects.toThrow(
      'Synthetic lost',
    );
    complete.mockRestore();
    expect(await store.reviews.reject(f.ctx, f.candidateId, 'Keep current memory')).toMatchObject({
      candidateId: f.candidateId,
      outcome: 'rejected',
    });
    expect((await store.inbox.detail(f.ctx, f.candidateId)).status).toBe('rejected');
    expect(await receiptCount(f.tenantId, f.candidateId)).toBe(1);
    await expect(store.reviews.reject(f.ctx, f.candidateId, 'Different reason')).rejects.toThrow(
      'different action or reason',
    );
  });

  it.each(['approve', 'reject'] as const)(
    'shared corrections recover their original %s result through the review facade',
    async (action) => {
      const f = await proposal('client-soul', true);
      const decide = () =>
        action === 'approve'
          ? store.reviews.approve(f.ctx, f.candidateId)
          : store.reviews.reject(f.ctx, f.candidateId, 'Keep original');
      const first = await decide();
      expect(await decide()).toEqual(first);
      expect(first.candidateKind).toBe('correction');
      expect(await receiptCount(f.tenantId, f.candidateId)).toBe(1);
      expect((await store.inbox.detail(f.ctx, f.candidateId)).status).toBe(
        action === 'approve' ? 'approved' : 'rejected',
      );
    },
  );

  it('an audit receipt failure rolls back publication and permits one later approval', async () => {
    const f = await proposal();
    await store.db.$executeRawUnsafe(
      "ALTER TABLE memory_transition_audit ADD CONSTRAINT synthetic_decision_receipt_failure CHECK (metadata_jsonb->>'decisionVersion' IS NULL) NOT VALID",
    );
    try {
      await expect(
        store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve'),
      ).rejects.toThrow();
      expect(
        (await store.db.memoryCandidate.findUniqueOrThrow({ where: { id: f.candidateId } })).status,
      ).toBe('pending');
      expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
      expect(await store.db.clioMemory.count({ where: { tenantId: f.tenantId } })).toBe(0);
    } finally {
      await store.db.$executeRawUnsafe(
        'ALTER TABLE memory_transition_audit DROP CONSTRAINT synthetic_decision_receipt_failure',
      );
    }
    await store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve');
    expect(await receiptCount(f.tenantId, f.candidateId)).toBe(1);
  });

  it('a newly applied client wall prevents readback of a previous shared decision', async () => {
    const f = await proposal('client-soul');
    await store.reviews.approve(f.ctx, f.candidateId);
    await store.scoped(f.tenantId, (tx) =>
      tx.client.update({ where: { id: f.clientId }, data: { memoryWall: true } }),
    );
    await expect(store.reviews.approve(f.ctx, f.candidateId)).rejects.toThrow('unavailable');
  });

  it('refuses receipt readback after membership withdrawal or from another actor', async () => {
    const f = await proposal();
    await store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve');
    await expect(
      store.candidates.approve(f.tenantId, f.candidateId, randomUUID(), {
        ...f.ctx,
        userId: randomUUID(),
      }),
    ).rejects.toThrow();
    await store.scoped(f.tenantId, (tx) =>
      tx.tenantMembership.updateMany({
        where: { tenantId: f.tenantId, userId: f.userId },
        data: { status: 'removed' },
      }),
    );
    await expect(
      store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve'),
    ).rejects.toThrow();
  });

  it('retains no draft body in the receipt and refuses unavailable legacy evidence without replay', async () => {
    const f = await proposal();
    await store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve');
    const audits = await store.db.memoryTransitionAudit.findMany({
      where: { tenantId: f.tenantId, memoryCandidateId: f.candidateId },
    });
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain(
      'Exact reviewed replacement',
    );
    const before = store.projected();
    // The fixture omits append-only history triggers: simulate an old backup that
    // has the committed row but lacks the new exact outcome evidence.
    await store.db.memoryTransitionAudit.deleteMany({
      where: { tenantId: f.tenantId, memoryCandidateId: f.candidateId },
    });
    await expect(
      store.candidates.decideOwnPersonalCandidate(f.ctx, f.candidateId, 'approve'),
    ).rejects.toThrow('original memory decision receipt is unavailable');
    expect(store.projected()).toBe(before);
  });
});
