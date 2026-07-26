// Engagement Phase 0 (plan §3.b2) — the auditor must FAIL CLOSED under enforce.
//
// This is the spec that guards the actual release blocker. Before Phase 0, all
// three control failures below (auditor throws, audit-ledger write fails,
// review-row write fails) were caught and logged, and the draft stayed exactly as
// sendable as if it had passed. Each of them now has to leave the exact version
// non-sendable.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import {
  OutreachAuditUnavailableError,
  OutreachDraftAuditService,
} from './outreach-draft-audit.service.js';
import { isDraftVersionSendable } from './outreach-draft.types.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

/**
 * A body that trips a REAL deterministic grounding check (D12, enactment proof)
 * against the ledger below: the tool data records H.R.1 at 'introduced', but the
 * draft tells the recipient it was signed into law. Using a genuine finding
 * rather than a stubbed verdict means this spec also proves the ledger is wired
 * through to the auditor in the shape it expects.
 */
const CONTRADICTING_BODY = 'H.R.1 was signed into law last week, so funding is now guaranteed.';
const LEDGER = [
  {
    tool: 'get_bill_status',
    serialized: 'H.R.1 status',
    // billId must appear verbatim in the prose for D12 to fire — that precision
    // guard is the auditor's, and this fixture respects it.
    result: { billId: 'H.R.1', status: 'introduced', statusAt: '2026-01-05T00:00:00Z' },
  },
];

interface Harness {
  service: OutreachDraftAuditService;
  versionUpdates: Array<Record<string, unknown>>;
  ledgerCreates: number;
  reviewCreates: Array<Record<string, unknown>>;
}

function makeHarness(opts: {
  mode: 'off' | 'shadow' | 'annotate' | 'enforce';
  body?: string;
  ledger?: unknown[];
  failLedgerWrite?: boolean;
  failReviewWrite?: boolean;
  failVersionWrite?: boolean;
}): Harness {
  const versionUpdates: Array<Record<string, unknown>> = [];
  const reviewCreates: Array<Record<string, unknown>> = [];
  const counters = { ledgerCreates: 0 };

  const tx = {
    outreachDraftVersion: {
      findFirst: async () => ({
        id: 'v-1',
        subject: 'Funding update',
        body: opts.body ?? CONTRADICTING_BODY,
        contentHash: 'sha256:abc',
        version: 1,
        artifactId: 'art-1',
        auditLedger: opts.ledger ?? LEDGER,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        promptSpecVersion: 'v2.1',
        artifact: {
          generationKey: 'individual:a@x.com',
          recipientKey: 'a@x.com',
          recipientSnapshot: { name: 'Jane Smith' },
          outreachRecordId: 'rec-1',
          outreachRecord: { clientId: 'client-1' },
        },
      }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.failVersionWrite) throw new Error('version write failed');
        versionUpdates.push(data);
        return { count: 1 };
      },
    },
    meriAuditLedger: {
      create: async () => {
        if (opts.failLedgerWrite) throw new Error('meri_audit_ledger insert failed');
        counters.ledgerCreates++;
        return { id: 'ledger-1' };
      },
    },
    reviewRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.failReviewWrite) throw new Error('review_request insert failed');
        reviewCreates.push(data);
        return { id: 'rr-1' };
      },
    },
    tenant: {
      // resolveTenantAuditorMode reads tenant.settings; the per-tenant override
      // is what actually decides the mode in these cases.
      findFirst: async () => ({ settings: { clioFeatureFlags: { meriAuditorMode: opts.mode } } }),
    },
  };

  const service = Object.create(OutreachDraftAuditService.prototype) as OutreachDraftAuditService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.prisma = { withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx) };

  return {
    service,
    versionUpdates,
    get ledgerCreates() {
      return counters.ledgerCreates;
    },
    reviewCreates,
  } as Harness;
}

describe('auditor mode: off', () => {
  test('nothing to verify → not_required / not_required, and it is SENDABLE', async () => {
    const h = makeHarness({ mode: 'off' });
    const out = await h.service.runForVersion(ctx, 'v-1');
    expect(out.auditStatus).toBe('not_required');
    expect(out.approvalStatus).toBe('not_required');
    expect(isDraftVersionSendable(out)).toBe(true);
    expect(h.ledgerCreates).toBe(0);
    expect(h.reviewCreates).toHaveLength(0);
  });
});

describe('clean draft', () => {
  test('no findings → passed, no review, sendable', async () => {
    const h = makeHarness({
      mode: 'enforce',
      body: 'Thank you for meeting with our team last month. We would value your continued support.',
      ledger: [],
    });
    const out = await h.service.runForVersion(ctx, 'v-1');
    expect(out.auditStatus).toBe('passed');
    expect(out.findingCount).toBe(0);
    expect(isDraftVersionSendable(out)).toBe(true);
    expect(h.reviewCreates).toHaveLength(0);
  });
});

describe('findings under NON-blocking modes', () => {
  test('shadow → visible warning, still sendable, no review row', async () => {
    const h = makeHarness({ mode: 'shadow' });
    const out = await h.service.runForVersion(ctx, 'v-1');
    expect(out.auditStatus).toBe('warning');
    expect(out.findingCount).toBeGreaterThan(0);
    expect(isDraftVersionSendable(out)).toBe(true);
    expect(h.reviewCreates).toHaveLength(0);
    // Evidence is still recorded even though nothing is blocked.
    expect(h.ledgerCreates).toBe(1);
  });

  test('annotate → warning plus an INTERNAL contextNote (never body/subject)', async () => {
    const h = makeHarness({ mode: 'annotate' });
    const out = await h.service.runForVersion(ctx, 'v-1');
    expect(out.auditStatus).toBe('warning');
    expect(out.contextNote).toMatch(/Unverified/i);
    // The note is metadata on the outcome; no write touches subject or body.
    for (const u of h.versionUpdates) {
      expect(u).not.toHaveProperty('subject');
      expect(u).not.toHaveProperty('body');
    }
  });
});

describe('findings under ENFORCE', () => {
  test('any finding HOLDS the version and creates a review for that EXACT version id', async () => {
    const h = makeHarness({ mode: 'enforce' });
    const out = await h.service.runForVersion(ctx, 'v-1');
    expect(out.auditStatus).toBe('held');
    expect(out.approvalStatus).toBe('pending');
    expect(isDraftVersionSendable(out)).toBe(false);
    expect(out.reviewRequestId).toBe('rr-1');

    const review = h.reviewCreates[0]!;
    expect(review.surface).toBe('outreach');
    expect(review.subjectType).toBe('outreach-draft-version');
    expect(review.subjectId).toBe('v-1');
    // Outreach is an external send: the restricted tier, which BLOCKS.
    expect(review.riskTier).toBe('restricted');
  });

  test('the review payload carries IDs + check names only — never the draft body', async () => {
    const h = makeHarness({ mode: 'enforce' });
    await h.service.runForVersion(ctx, 'v-1');
    const payload = h.reviewCreates[0]!.payload as Record<string, unknown>;
    expect(payload.versionId).toBe('v-1');
    expect(payload.contentHash).toBe('sha256:abc');
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload).not.toHaveProperty('body');
    expect(payload).not.toHaveProperty('subject');
    // Defence in depth: the body text must not appear anywhere in the payload.
    expect(JSON.stringify(payload)).not.toContain('signed into law');
  });

  test('the ledger row is written BEFORE the version is marked held', async () => {
    const h = makeHarness({ mode: 'enforce' });
    await h.service.runForVersion(ctx, 'v-1');
    expect(h.ledgerCreates).toBe(1);
    // The held state is written after (inside the review transaction).
    expect(h.versionUpdates.some((u) => u.auditStatus === 'held')).toBe(true);
  });
});

describe('CONTROL FAILURES fail closed under enforce', () => {
  test('audit-ledger write failure blocks the send (unavailable + throws)', async () => {
    const h = makeHarness({ mode: 'enforce', failLedgerWrite: true });
    await expect(h.service.runForVersion(ctx, 'v-1')).rejects.toBeInstanceOf(
      OutreachAuditUnavailableError,
    );
    const written = h.versionUpdates.at(-1)!;
    expect(written.auditStatus).toBe('unavailable');
    expect(written.approvalStatus).toBe('pending');
    expect(written.auditDecision).toBe('audit_unavailable');
    expect(
      isDraftVersionSendable({
        auditStatus: written.auditStatus as never,
        approvalStatus: written.approvalStatus as never,
      }),
    ).toBe(false);
    // No review row exists, so the draft is NOT "held awaiting review" either.
    expect(h.reviewCreates).toHaveLength(0);
  });

  test('review-row write failure blocks the send — never held-without-review', async () => {
    const h = makeHarness({ mode: 'enforce', failReviewWrite: true });
    await expect(h.service.runForVersion(ctx, 'v-1')).rejects.toBeInstanceOf(
      OutreachAuditUnavailableError,
    );
    const written = h.versionUpdates.at(-1)!;
    expect(written.auditStatus).toBe('unavailable');
    expect(h.reviewCreates).toHaveLength(0);
  });

  test('even when the state write ALSO fails, enforce still throws (never returns sendable)', async () => {
    const h = makeHarness({ mode: 'enforce', failLedgerWrite: true, failVersionWrite: true });
    await expect(h.service.runForVersion(ctx, 'v-1')).rejects.toBeInstanceOf(
      OutreachAuditUnavailableError,
    );
    // The version keeps its creation-time 'pending' status, which is blocked.
    expect(isDraftVersionSendable({ auditStatus: 'pending', approvalStatus: 'not_required' })).toBe(
      false,
    );
  });

  test('shadow/annotate surface the SAME failure as a visible warning, without blocking', async () => {
    const h = makeHarness({ mode: 'shadow', failLedgerWrite: true });
    const out = await h.service.runForVersion(ctx, 'v-1');
    expect(out.auditStatus).toBe('warning');
    expect(out.auditDecision).toBe('audit_unavailable');
    // Non-blocking mode: generation continues, but the state is visible.
    expect(isDraftVersionSendable(out)).toBe(true);
    expect(out.contextNote).toMatch(/unavailable/i);
  });
});
