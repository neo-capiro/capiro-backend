import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReviewsService } from './reviews.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EngagementService } from '../engagement/engagement.service.js';
import type { OutreachDraftService } from '../engagement/outreach-draft.service.js';
import type { TenantContext } from '@capiro/shared';

const admin: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro-internal',
  userId: 'admin-1',
  clerkUserId: 'clerk_admin',
  role: 'user_admin',
};
const analyst: TenantContext = { ...admin, userId: 'analyst-1', role: 'standard_user' };
const reviewer: TenantContext = { ...admin, userId: 'reviewer-1', role: 'standard_user' };

function makeService(pending: Record<string, unknown> | null) {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const execRaw = jest.fn(async () => 1);
  const tx = {
    reviewRequest: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'rr-1', ...a.data })),
      findFirst: jest.fn(async () => pending),
      findMany: jest.fn(async () => []),
      update: jest.fn(async (a: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(a);
        return { id: 'rr-1', ...a.data };
      }),
    },
    $executeRaw: execRaw,
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-9', fileName: 'memo.docx' })),
  } as unknown as EngagementService;
  // Phase 0: ReviewsService also takes OutreachDraftService. These cases cover
  // the alert-memo/research surfaces only, so a stub that THROWS if touched is
  // the right double - it proves the outreach path is not entered for them.
  const outreachDrafts = {
    decideWithinTx: jest.fn(async () => {
      throw new Error('outreach draft path must not be used for this surface');
    }),
    getVersionForReviewerUnchecked: jest.fn(async () => null),
  } as unknown as OutreachDraftService;
  const service = new ReviewsService(prisma, engagement, outreachDrafts);
  return { service, updates, execRaw, engagement };
}

const heldMemo = {
  id: 'rr-1',
  surface: 'alert-memo',
  clientId: 'c-1',
  assignedTo: null as string | null,
  payload: { markdown: '# Held memo\n\nBody.', title: 'H.R.8800 memo', clientName: 'Acme' },
};

describe('ReviewsService (G4 named-reviewer routing)', () => {
  it('createSystem is fail-open (never throws, returns null on failure)', async () => {
    const boom = new ReviewsService(
      { withTenant: jest.fn().mockRejectedValue(new Error('db down')) } as unknown as PrismaService,
      {} as EngagementService,
      {} as OutreachDraftService,
    );
    await expect(
      boom.createSystem('t1', {
        riskTier: 'high',
        surface: 'alert-memo',
        subjectType: 'alert',
        title: 'x',
        reason: 'y',
        payload: {},
      }),
    ).resolves.toBeNull();
  });

  it('approve by an admin RELEASES the held memo (files the docx) and stamps approved', async () => {
    const { service, updates, engagement } = makeService(heldMemo);
    const res = await service.approve(admin, 'rr-1');
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalled();
    expect(res.released).toMatchObject({ attachmentId: 'att-9' });
    expect(updates[0]!.data).toMatchObject({ status: 'approved', decidedBy: 'admin-1' });
  });

  it('approve by the ASSIGNED reviewer is allowed; by a random analyst is Forbidden', async () => {
    const assigned = { ...heldMemo, assignedTo: 'reviewer-1' };
    const { service } = makeService(assigned);
    await expect(service.approve(reviewer, 'rr-1')).resolves.toMatchObject({ ok: true });

    const { service: s2 } = makeService(assigned);
    await expect(s2.approve(analyst, 'rr-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approve on an unknown/decided id 404s', async () => {
    const { service } = makeService(null);
    await expect(service.approve(admin, 'rr-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reject stamps rejected and does NOT file anything', async () => {
    const { service, updates, engagement } = makeService(heldMemo);
    await service.reject(admin, 'rr-1');
    expect(engagement.createAttachmentFromBuffer).not.toHaveBeenCalled();
    expect(updates[0]!.data).toMatchObject({ status: 'rejected', decidedBy: 'admin-1' });
  });

  it('research approve clears heldForReview on the artifact (no docx)', async () => {
    const { service, execRaw, engagement } = makeService({
      id: 'rr-2',
      surface: 'research',
      clientId: null,
      assignedTo: null,
      payload: { artifactId: 'art-1' },
    });
    const res = await service.approve(admin, 'rr-2');
    expect(engagement.createAttachmentFromBuffer).not.toHaveBeenCalled();
    expect(execRaw).toHaveBeenCalled(); // the metadata UPDATE
    expect(res.released).toMatchObject({ artifactId: 'art-1', heldForReview: false });
  });

  it('hasOpenForSubject reflects a pending row', async () => {
    const { service } = makeService({ id: 'rr-1' });
    expect(await service.hasOpenForSubject('t1', 'alert', 'a-1')).toBe(true);
    const { service: s2 } = makeService(null);
    expect(await s2.hasOpenForSubject('t1', 'alert', 'a-1')).toBe(false);
  });
});
