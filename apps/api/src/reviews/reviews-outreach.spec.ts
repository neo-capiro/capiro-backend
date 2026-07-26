// Engagement Phase 0 (plan §3.f1/§3.f2) — Reviews releases ONE EXACT version.
//
// What must hold:
//   • approve() releases the exact reviewed version and stamps the decision in
//     the SAME transaction;
//   • the requester still cannot self-approve (assertMayDecide is not weakened);
//   • the legacy content-keyed surface keeps working for historical rows;
//   • GET /reviews/:id serves the protected draft body only to admin / assignee /
//     requester, and marks a requester view-only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ReviewsService } from './reviews.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EngagementService } from '../engagement/engagement.service.js';
import type { OutreachDraftService } from '../engagement/outreach-draft.service.js';

const admin: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'admin-1',
  clerkUserId: 'clerk-admin',
  role: 'user_admin',
};
const reviewer: TenantContext = { ...admin, userId: 'reviewer-1', role: 'standard_user' };
const requester: TenantContext = { ...admin, userId: 'author-1', role: 'standard_user' };
const stranger: TenantContext = { ...admin, userId: 'stranger-1', role: 'standard_user' };

const VERSIONED_REVIEW = {
  id: 'rr-1',
  riskTier: 'restricted',
  surface: 'outreach',
  subjectType: 'outreach-draft-version',
  subjectId: 'v-1',
  clientId: 'client-1',
  title: 'Held outreach draft v1 — Jane Smith',
  reason: 'D12 (critical)',
  status: 'pending',
  payload: { versionId: 'v-1', checks: [{ check: 'D12', severity: 'critical' }] },
  requestedBy: 'author-1',
  assignedTo: 'reviewer-1',
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date('2026-07-27T00:00:00Z'),
};

const DRAFT_VERSION = {
  id: 'v-1',
  artifactId: 'art-1',
  outreachRecordId: 'rec-1',
  version: 1,
  sourceVersionId: null,
  generationKey: 'individual:a@x.com',
  recipientKey: 'a@x.com',
  audienceKind: 'individual',
  subject: 'Funding update',
  body: 'H.R.1 was signed into law last week.',
  contentHash: 'sha256:abc',
  generationStatus: 'generated' as const,
  auditStatus: 'held' as const,
  approvalStatus: 'pending' as const,
  auditDecision: 'hold',
  auditChecks: [{ check: 'D12', severity: 'critical' }],
  reviewRequestId: 'rr-1',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  promptSpecVersion: 'v2.1',
  sendable: false,
  createdAt: '2026-07-27T00:00:00.000Z',
};

function makeService(review: Record<string, unknown> | null) {
  const order: string[] = [];
  const stamps: Array<Record<string, unknown>> = [];
  const decisions: Array<{ versionId: string; reviewId: string; decision: string }> = [];
  let txDepth = 0;
  const maxDepth = { value: 0 };

  const tx = {
    reviewRequest: {
      findFirst: async () => review,
      update: async (a: { data: Record<string, unknown> }) => {
        order.push('stamp');
        stamps.push(a.data);
        return { id: 'rr-1', ...a.data };
      },
      create: async () => ({ id: 'rr-1' }),
      findMany: async () => [],
    },
    $executeRaw: async () => 1,
  };

  const prisma = {
    withTenant: async (_t: string, fn: (t: unknown) => unknown) => {
      txDepth++;
      maxDepth.value = Math.max(maxDepth.value, txDepth);
      try {
        return await fn(tx);
      } finally {
        txDepth--;
      }
    },
  } as unknown as PrismaService;

  const outreachDrafts = {
    decideWithinTx: async (
      _tx: unknown,
      _tenantId: string,
      versionId: string,
      reviewId: string,
      decision: string,
    ) => {
      order.push(`decide:${decision}`);
      decisions.push({ versionId, reviewId, decision });
      return {
        ...DRAFT_VERSION,
        version: 1,
        auditStatus: decision === 'approved' ? 'passed' : 'held',
        approvalStatus: decision === 'approved' ? 'approved' : 'rejected',
      };
    },
    getVersionForReviewerUnchecked: async () => DRAFT_VERSION,
  } as unknown as OutreachDraftService;

  const engagement = {
    createAttachmentFromBuffer: jest.fn(async () => ({ id: 'att-1', fileName: 'x.docx' })),
  } as unknown as EngagementService;

  return {
    service: new ReviewsService(prisma, engagement, outreachDrafts),
    order,
    stamps,
    decisions,
    maxDepth,
  };
}

describe('approve — exact-version release', () => {
  test('releases the reviewed version, then stamps, inside ONE transaction', async () => {
    const h = makeService(VERSIONED_REVIEW);
    const out = await h.service.approve(admin, 'rr-1');
    // Version decision happens BEFORE the stamp, in the same transaction.
    expect(h.order).toEqual(['decide:approved', 'stamp']);
    expect(h.maxDepth.value).toBe(1); // never a nested transaction
    expect(h.decisions[0]).toEqual({
      versionId: 'v-1',
      reviewId: 'rr-1',
      decision: 'approved',
    });
    expect(out.released).toMatchObject({
      draftVersionId: 'v-1',
      auditStatus: 'passed',
      approvalStatus: 'approved',
      sendUnblocked: true,
    });
  });

  test('the approval targets ONLY the reviewed version id', async () => {
    const h = makeService({ ...VERSIONED_REVIEW, subjectId: 'v-7' });
    await h.service.approve(admin, 'rr-1');
    expect(h.decisions[0]!.versionId).toBe('v-7');
  });

  test('the ASSIGNED reviewer may decide', async () => {
    const h = makeService(VERSIONED_REVIEW);
    await expect(h.service.approve(reviewer, 'rr-1')).resolves.toMatchObject({ ok: true });
  });

  test('the REQUESTER may NOT self-approve (assertMayDecide not weakened)', async () => {
    const h = makeService(VERSIONED_REVIEW);
    await expect(h.service.approve(requester, 'rr-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.decisions).toHaveLength(0);
    expect(h.stamps).toHaveLength(0);
  });

  test('an unrelated standard user may not decide', async () => {
    const h = makeService(VERSIONED_REVIEW);
    await expect(h.service.approve(stranger, 'rr-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('reject — version keeps its hold', () => {
  test('rejects the exact version and stamps in one transaction', async () => {
    const h = makeService(VERSIONED_REVIEW);
    await h.service.reject(admin, 'rr-1');
    expect(h.order).toEqual(['decide:rejected', 'stamp']);
    expect(h.decisions[0]!.decision).toBe('rejected');
    expect(h.stamps[0]!.status).toBe('rejected');
  });
});

describe('legacy content-keyed outreach reviews (historical rows)', () => {
  const legacy = {
    ...VERSIONED_REVIEW,
    subjectType: 'outreach-draft',
    subjectId: 'sha256:deadbeef',
  };

  test('still approve via the generic release path — the version path is NOT used', async () => {
    const h = makeService(legacy);
    const out = await h.service.approve(admin, 'rr-1');
    expect(h.decisions).toHaveLength(0); // no version decision attempted
    expect(out.released).toMatchObject({ sendUnblocked: true, legacyContentKeyedHold: true });
    expect(h.stamps[0]!.status).toBe('approved');
  });

  test('a versioned subjectType with a MISSING subjectId falls back to legacy, not a crash', async () => {
    const h = makeService({ ...VERSIONED_REVIEW, subjectId: null });
    const out = await h.service.approve(admin, 'rr-1');
    expect(h.decisions).toHaveLength(0);
    expect(out.released).toMatchObject({ legacyContentKeyedHold: true });
  });
});

describe('detail — the protected draft view (§3.f2)', () => {
  test('an admin sees the held subject/body and may decide', async () => {
    const h = makeService(VERSIONED_REVIEW);
    const out = (await h.service.detail(admin, 'rr-1')) as Record<string, unknown>;
    const version = out.draftVersion as Record<string, unknown>;
    expect(version.subject).toBe('Funding update');
    expect(version.body).toContain('H.R.1');
    expect(version.auditChecks).toEqual([{ check: 'D12', severity: 'critical' }]);
    expect(out.mayDecide).toBe(true);
  });

  test('the assigned reviewer may view and decide', async () => {
    const h = makeService(VERSIONED_REVIEW);
    const out = (await h.service.detail(reviewer, 'rr-1')) as Record<string, unknown>;
    expect(out.mayDecide).toBe(true);
    expect(out.draftVersion).not.toBeNull();
  });

  test('the requester may VIEW but is marked view-only', async () => {
    const h = makeService(VERSIONED_REVIEW);
    const out = (await h.service.detail(requester, 'rr-1')) as Record<string, unknown>;
    expect(out.draftVersion).not.toBeNull();
    expect(out.mayDecide).toBe(false);
  });

  test('an unrelated user is FORBIDDEN — the held body is not exposed', async () => {
    const h = makeService(VERSIONED_REVIEW);
    await expect(h.service.detail(stranger, 'rr-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  test('a missing review is a 404', async () => {
    const h = makeService(null);
    await expect(h.service.detail(admin, 'rr-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('the response carries no tokens, raw LLM output, or unrelated packet bodies', async () => {
    const h = makeService(VERSIONED_REVIEW);
    const out = (await h.service.detail(admin, 'rr-1')) as Record<string, unknown>;
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/access_?token|refresh_?token|ciphertext|authTag/i);
    expect(out.draftVersion).not.toHaveProperty('raw');
    expect(out.draftVersion).not.toHaveProperty('auditLedger');
  });
});

/**
 * Phase 0 §3.d3 — the module wiring rule, asserted structurally.
 *
 * ReviewsModule already imports EngagementModule. If EngagementModule ever
 * imports ReviewsModule back, Nest hits a module cycle and the API fails to boot
 * — a failure that unit tests with hand-built providers would never catch.
 * OutreachDraftService is EXPORTED instead, and ReviewsService injects it.
 */
describe('module wiring (no Engagement <-> Reviews cycle)', () => {
  const engagementModule = readFileSync(
    join(__dirname, '..', 'engagement', 'engagement.module.ts'),
    'utf8',
  );

  test('EngagementModule does NOT import ReviewsModule', () => {
    // Assert on real syntax, not raw text: the file legitimately MENTIONS
    // ReviewsModule in the comment explaining why it must not import it.
    expect(engagementModule).not.toMatch(/^\s*import\s+.*reviews\.module/m);
    const importsBlock = /imports:\s*\[([\s\S]*?)\]/.exec(engagementModule)?.[1] ?? '';
    expect(importsBlock).not.toContain('Reviews');
  });

  test('EngagementModule EXPORTS OutreachDraftService so Reviews can inject it', () => {
    const exportsBlock = /exports:\s*\[([\s\S]*?)\]/.exec(engagementModule)?.[1] ?? '';
    expect(exportsBlock).toContain('OutreachDraftService');
  });

  test('all three Phase 0 services are registered as providers', () => {
    const providersBlock = /providers:\s*\[([\s\S]*?)\]/.exec(engagementModule)?.[1] ?? '';
    for (const provider of [
      'OutreachDraftService',
      'OutreachDraftAuditService',
      'OutreachSendIntentService',
    ]) {
      expect(providersBlock).toContain(provider);
    }
  });
});
