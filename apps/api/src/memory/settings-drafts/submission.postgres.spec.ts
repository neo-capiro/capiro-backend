import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import {
  parseMemoryDraftFile,
  parseMemoryDraftRead,
  parseMemoryDraftReceipt,
  parseMemoryDraftSubmissionReceipt,
} from '@capiro/shared/settings-memory-drafts';
import { settingsSubmissionFixture } from './submission.postgres-fixture.js';
import { ownerRetentionCase } from '../memory-owner-retention.postgres-fixture.js';
import { fileDefForType } from '../memory-catalog.js';

jest.mock('../memory-embedding-lifecycle.js', () => ({
  embedMemoryItem: jest.fn(async () => ({ status: 'skipped' })),
}));
const url = process.env.MEMORY_SUBMISSION_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Settings draft to canonical review and publication', () => {
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
  async function fixture(type = 'user-profile', existing = false) {
    const f = await ownerRetentionCase(store),
      ctx = { ...f, role: 'user_admin' } as unknown as TenantContext;
    const slug = type === 'user-profile' ? 'me' : type === 'client-soul' ? f.clientId : 'firm';
    const key = fileDefForType(type)!.sections[0]!.key;
    const source = existing
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
              title: 'Synthetic source',
              source: 'manual',
              sections: [
                { key, heading: 'Source section', owner: 'human', body: 'Original active content' },
              ],
            },
          }),
        )
      : null;
    const base = await store.drafts.readFile(ctx, type, slug),
      id = randomUUID(),
      requestId = randomUUID();
    const saved = await store.drafts.save(ctx, type, slug, id, {
      requestId,
      expectedRevision: 0,
      action: 'save',
      baseItemId: base.baseItemId,
      baseVersion: base.baseVersion,
      sections: [{ key, body: 'Reviewed new content' }],
    });
    const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
    expect(parseMemoryDraftFile(wire(base))).toEqual(wire(base));
    expect(parseMemoryDraftReceipt(wire(saved))).toEqual(wire(saved));
    const read = await store.drafts.read(ctx, type, slug, id);
    expect(parseMemoryDraftRead(wire(read))).toEqual(wire(read));
    return {
      ...f,
      ctx,
      type,
      slug,
      id,
      source,
      key,
      submit: { requestId: randomUUID(), expectedRevision: 1 },
    };
  }
  it('submits personal additions once, keeps them private and publishes through owner review', async () => {
    const f = await fixture();
    const before = store.projected();
    const receipt = await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit);
    expect(receipt).toMatchObject({
      status: 'pending_review',
      activeItemUnchanged: true,
      draftRevision: 1,
    });
    expect(parseMemoryDraftSubmissionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(
      JSON.parse(JSON.stringify(receipt)),
    );
    expect(await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit)).toEqual(receipt);
    expect(
      await store.submissions.receipt(f.ctx, f.type, f.slug, f.id, f.submit.requestId),
    ).toEqual(receipt);
    expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(store.projected()).toBe(before);
    expect(
      (await store.candidates.pageOwnPersonalPending(f.ctx)).candidates.map((c) => c.id),
    ).toContain(receipt.candidateId);
    expect(await store.candidates.listPending(f.tenantId, randomUUID())).toEqual([]);
    await store.candidates.decideOwnPersonalCandidate(f.ctx, receipt.candidateId, 'approve');
    const active = await store.drafts.readFile(f.ctx, f.type, f.slug);
    expect(active.baseItemId).not.toBeNull();
    expect(active.sections.find((s) => s.key === f.key)?.body).toBe('Reviewed new content');
    expect(await store.db.memorySettingsDraft.findUnique({ where: { id: f.id } })).toMatchObject({
      state: 'submitted',
      sections: null,
      revision: 2,
    });
  });
  it('refuses shared submission without a current eligible reviewer, before creating a candidate', async () => {
    const f = await fixture('firm-soul');
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId },
      data: { role: 'standard_user' },
    });
    await expect(store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit)).rejects.toThrow(
      'No eligible',
    );
    expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect((await store.drafts.read(f.ctx, f.type, f.slug, f.id)).revision).toBe(1);
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId },
      data: { role: 'user_admin' },
    });
    const receipt = await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit);
    expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
    await store.candidates.approve(f.tenantId, receipt.candidateId, f.userId, f.ctx);
    expect(
      (await store.drafts.readFile(f.ctx, f.type, f.slug)).sections.find((s) => s.key === f.key)
        ?.body,
    ).toBe('Reviewed new content');
  });
  it('creates a section-preserving personal correction and publishes a new immutable version', async () => {
    const f = await fixture('user-profile', true);
    const receipt = await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit);
    expect(
      (await store.db.memoryItem.findUniqueOrThrow({ where: { id: f.source!.id } })).status,
    ).toBe('active');
    const candidate = await store.db.memoryCandidate.findUniqueOrThrow({
      where: { id: receipt.candidateId },
    });
    expect(candidate.scope).toBe('personal');
    expect(candidate.sourceKind).toBe('memory_correction');
    const approved = await store.immutable.approveCandidate(f.ctx, receipt.candidateId);
    expect(approved.outcome).toBe('activated');
    expect(approved.memoryItemId).not.toBe(f.source!.id);
    const prior = await store.db.memoryItem.findUniqueOrThrow({ where: { id: f.source!.id } });
    expect(prior.status).toBe('superseded');
    expect(prior.sections).toEqual(f.source!.sections);
    const published = await store.db.memoryItem.findUniqueOrThrow({
      where: { id: approved.memoryItemId! },
    });
    expect(published.supersedesId).toBe(prior.id);
    expect(published.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: f.key, body: 'Reviewed new content' }),
      ]),
    );
  });
  it('refuses a correction if its exact source changes after submission', async () => {
    const f = await fixture('user-profile', true);
    const receipt = await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit);
    await store.db.memoryItem.update({
      where: { id: f.source!.id },
      data: {
        sections: [
          { key: f.key, heading: 'Changed', owner: 'human', body: 'Newer active content' },
        ],
      },
    });
    await expect(store.immutable.approveCandidate(f.ctx, receipt.candidateId)).rejects.toThrow(
      'source changed',
    );
    expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(
      (await store.db.memoryCandidate.findUniqueOrThrow({ where: { id: receipt.candidateId } }))
        .status,
    ).toBe('pending');
  });
  it('preserves source-held and directly held private drafts before any submission effect', async () => {
    for (const hold of ['source', 'draft']) {
      const f = await fixture('user-profile', true);
      if (hold === 'source')
        await store.db.memoryItem.update({
          where: { id: f.source!.id },
          data: { legalHold: true },
        });
      else
        await store.db.memorySettingsDraft.update({
          where: { id: f.id },
          data: { legalHold: true },
        });
      await expect(store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit)).rejects.toThrow(
        /held|legal hold/,
      );
      expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(0);
      expect(
        await store.db.memorySettingsSubmission.count({ where: { tenantId: f.tenantId } }),
      ).toBe(0);
      expect(await store.db.memorySettingsDraft.findUnique({ where: { id: f.id } })).toMatchObject({
        state: 'draft',
        revision: 1,
        sections: [{ key: f.key, body: 'Reviewed new content' }],
      });
    }
  });
  it('concurrent exact retries return one historical receipt after publication and reject revoked recovery', async () => {
    const f = await fixture();
    const receipts = await Promise.all([
      store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit),
      store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    await store.candidates.decideOwnPersonalCandidate(f.ctx, receipts[0]!.candidateId, 'approve');
    expect(
      await store.submissions.receipt(f.ctx, f.type, f.slug, f.id, f.submit.requestId),
    ).toEqual(receipts[0]);
    expect(await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit)).toEqual(
      receipts[0],
    );
    expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(1);
    await expect(
      store.submissions.receipt(f.ctx, f.type, f.slug, randomUUID(), f.submit.requestId),
    ).rejects.toThrow('receipt unavailable');
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId },
      data: { status: 'inactive' },
    });
    await expect(
      store.submissions.receipt(f.ctx, f.type, f.slug, f.id, f.submit.requestId),
    ).rejects.toThrow('Current memory access unavailable');
  });
  it('refuses changed source or draft revisions before creating any review item', async () => {
    const f = await fixture('user-profile', true);
    await expect(
      store.submissions.submit(f.ctx, f.type, f.slug, f.id, { ...f.submit, expectedRevision: 2 }),
    ).rejects.toThrow('Draft changed');
    await store.db.memoryItem.update({ where: { id: f.source!.id }, data: { sections: [] } });
    await expect(store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit)).rejects.toThrow(
      'Active memory changed',
    );
    expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
  it('concurrent submissions produce one candidate and rejected review leaves active content intact', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([
      store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit),
      store.submissions.submit(f.ctx, f.type, f.slug, f.id, {
        ...f.submit,
        requestId: randomUUID(),
      }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(1);
    const candidate = await store.db.memoryCandidate.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    await store.candidates.decideOwnPersonalCandidate(f.ctx, candidate.id, 'reject');
    expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
  it('a conflicting request identity refuses the second draft handoff and candidate', async () => {
    const f = await fixture();
    await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit);
    const second = randomUUID();
    await store.drafts.save(f.ctx, f.type, f.slug, second, {
      requestId: randomUUID(),
      expectedRevision: 0,
      action: 'save',
      baseItemId: null,
      baseVersion: null,
      sections: [{ key: f.key, body: 'Second draft' }],
    });
    await expect(store.submissions.submit(f.ctx, f.type, f.slug, second, f.submit)).rejects.toThrow(
      'Request identity was used',
    );
    expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await store.db.memorySettingsDraft.findUnique({ where: { id: second } })).toMatchObject({
      state: 'draft',
      revision: 1,
    });
  });
  it('an addition cannot overwrite a catalog file created while review was pending', async () => {
    const f = await fixture();
    const receipt = await store.submissions.submit(f.ctx, f.type, f.slug, f.id, f.submit);
    const first = await store.scoped(f.tenantId, (tx) =>
      tx.memoryItem.create({
        data: {
          tenantId: f.tenantId,
          ownerUserId: f.userId,
          visibility: 'user',
          memoryScope: 'user_private',
          memoryClass: 'user_preference',
          governedStatus: 'active',
          type: f.type,
          slug: f.userId,
          title: 'Other current version',
          source: 'manual',
          sections: [],
        },
      }),
    );
    await expect(
      store.candidates.decideOwnPersonalCandidate(f.ctx, receipt.candidateId, 'approve'),
    ).rejects.toThrow('created while');
    expect(
      (await store.db.memoryItem.findUniqueOrThrow({ where: { id: first.id } })).sections,
    ).toEqual([]);
    expect(await store.db.clioMemory.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
});
