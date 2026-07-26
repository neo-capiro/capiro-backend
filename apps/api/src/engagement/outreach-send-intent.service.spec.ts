// Engagement Phase 0 (plan §3.d1) — durable intent + at-most-once delivery.
//
// The assertions that matter here are ordering and non-repetition:
//   • the intent and its delivery rows are committed BEFORE the provider mock is
//     ever called;
//   • a duplicate request key calls the provider ZERO extra times;
//   • the same exact delivery cannot be created twice under a fresh key;
//   • an ambiguous provider outcome becomes 'unknown' and is never reset;
//   • a stale claim ages to 'unknown', never back to 'pending';
//   • provider acceptance followed by a database failure does NOT re-send.

import { describe, expect, test } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  OutreachSendIntentService,
  buildEnvelope,
  countByStatus,
  deliveryIdempotencyKey,
  isPromptSpecV2OrLater,
  rollUpStatus,
} from './outreach-send-intent.service.js';
import { AmbiguousMailSendError } from './mail-send-result.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('buildEnvelope', () => {
  test('a single recipient becomes one To entry', () => {
    const env = buildEnvelope({ email: 'a@x.com', name: 'A', cc: ['c@x.com'], bcc: [] });
    expect(env.to).toEqual([{ email: 'a@x.com', name: 'A' }]);
    expect(env.cc).toEqual(['c@x.com']);
  });

  test('a GROUP representative fans every member into ONE To list (not one email each)', () => {
    const env = buildEnvelope({
      email: 'rep@x.com',
      groupMembers: [
        { email: 'd@x.com', name: 'D' },
        { email: 'e@x.com' },
        { email: '  ' },
      ],
    });
    expect(env.to.map((t) => t.email)).toEqual(['d@x.com', 'e@x.com']);
  });

  test('a recipient with no email yields an EMPTY To (caller must reject it)', () => {
    expect(buildEnvelope({ name: 'No Email' }).to).toEqual([]);
    expect(buildEnvelope({ groupMembers: [] }).to).toEqual([]);
  });
});

describe('deliveryIdempotencyKey', () => {
  const base = {
    tenantId: 't1',
    senderConnectionId: 'conn-1',
    draftVersionId: 'v-1',
    envelope: { to: [{ email: 'a@x.com' }], cc: [], bcc: [] },
    manifest: [],
    testMode: false,
  };

  test('is stable, and address order/case does not change it', () => {
    const a = deliveryIdempotencyKey({
      ...base,
      envelope: { to: [{ email: 'a@x.com' }, { email: 'b@x.com' }], cc: [], bcc: [] },
    });
    const b = deliveryIdempotencyKey({
      ...base,
      envelope: { to: [{ email: 'B@X.com' }, { email: ' a@x.com ' }], cc: [], bcc: [] },
    });
    expect(a).toBe(b);
  });

  test('a CHANGED envelope produces a different key (a new intent is required)', () => {
    const a = deliveryIdempotencyKey(base);
    const b = deliveryIdempotencyKey({
      ...base,
      envelope: { to: [{ email: 'a@x.com' }], cc: ['new@x.com'], bcc: [] },
    });
    expect(a).not.toBe(b);
  });

  test('a different version, connection, attachment set, or test flag all differ', () => {
    const a = deliveryIdempotencyKey(base);
    expect(deliveryIdempotencyKey({ ...base, draftVersionId: 'v-2' })).not.toBe(a);
    expect(deliveryIdempotencyKey({ ...base, senderConnectionId: 'conn-2' })).not.toBe(a);
    expect(deliveryIdempotencyKey({ ...base, testMode: true })).not.toBe(a);
    expect(
      deliveryIdempotencyKey({
        ...base,
        manifest: [{ id: 'att-1', fileName: 'f', contentType: 'application/pdf', byteSize: 10 }],
      }),
    ).not.toBe(a);
  });
});

describe('rollUpStatus', () => {
  test('all sent → complete', () => {
    expect(rollUpStatus(countByStatus(['sent', 'sent']))).toBe('complete');
  });
  test('an UNKNOWN delivery keeps the intent out of complete', () => {
    expect(rollUpStatus(countByStatus(['sent', 'unknown']))).toBe('partial');
  });
  test('all failed → failed; mixed → partial', () => {
    expect(rollUpStatus(countByStatus(['failed', 'failed']))).toBe('failed');
    expect(rollUpStatus(countByStatus(['sent', 'failed']))).toBe('partial');
  });
  test('anything still in flight is queued/running, never terminal', () => {
    expect(rollUpStatus(countByStatus(['pending', 'pending']))).toBe('queued');
    expect(rollUpStatus(countByStatus(['sent', 'pending']))).toBe('running');
    expect(rollUpStatus(countByStatus(['sending']))).toBe('queued');
  });
});

describe('isPromptSpecV2OrLater (external-send gate)', () => {
  test('v2 and later pass; v1, empty and garbage do not', () => {
    expect(isPromptSpecV2OrLater('v2')).toBe(true);
    expect(isPromptSpecV2OrLater('v2.1')).toBe(true);
    expect(isPromptSpecV2OrLater('v10')).toBe(true);
    expect(isPromptSpecV2OrLater('v1')).toBe(false);
    expect(isPromptSpecV2OrLater(null)).toBe(false);
    expect(isPromptSpecV2OrLater('')).toBe(false);
    expect(isPromptSpecV2OrLater('legacy')).toBe(false);
  });
});

// ── createIntent ─────────────────────────────────────────────────────────────

interface IntentHarness {
  service: OutreachSendIntentService;
  providerCalls: number;
  createdIntents: Array<Record<string, unknown>>;
  createdDeliveries: Array<Record<string, unknown>>;
  orderLog: string[];
}

function makeIntentHarness(opts: {
  existingIntentId?: string | null;
  versionAudit?: string;
  versionApproval?: string;
  versionCurrent?: number;
  artifactCurrent?: number;
  promptSpecVersion?: string | null;
  v2Required?: boolean;
  attachmentByteSize?: number | null;
  duplicateDelivery?: boolean;
  recordOwner?: string;
}): IntentHarness {
  const createdIntents: Array<Record<string, unknown>> = [];
  const createdDeliveries: Array<Record<string, unknown>> = [];
  const orderLog: string[] = [];
  const counters = { providerCalls: 0 };

  const versionRow = {
    id: 'v-1',
    version: opts.versionCurrent ?? 1,
    subject: 'Subject',
    body: 'Body',
    auditStatus: opts.versionAudit ?? 'passed',
    approvalStatus: opts.versionApproval ?? 'not_required',
    promptSpecVersion: opts.promptSpecVersion === undefined ? 'v2.1' : opts.promptSpecVersion,
    artifact: {
      id: 'art-1',
      currentVersion: opts.artifactCurrent ?? 1,
      generationKey: 'individual:a@x.com',
      recipientKey: 'a@x.com',
      recipientSnapshot: { email: 'a@x.com', name: 'A', cc: [], bcc: [] },
      createdByUserId: 'u1',
      outreachRecordId: 'rec-1',
    },
  };

  const tx = {
    outreachRecord: {
      findFirst: async () => ({ id: 'rec-1', createdByUserId: opts.recordOwner ?? 'u1' }),
      updateMany: async () => ({ count: 1 }),
    },
    user: {
      findUnique: async () => ({
        email: 'me@capiro.ai',
        firstName: 'Neo',
        emailSignatureHtml: null,
        emailSignatureEnabled: false,
      }),
    },
    engagementAttachment: {
      findMany: async () => [
        {
          id: 'att-1',
          fileName: 'big.pdf',
          contentType: 'application/pdf',
          byteSize: opts.attachmentByteSize ?? 1024,
          s3Key: 'k',
        },
      ],
    },
    outreachDraftVersion: {
      findMany: async () => [versionRow],
    },
    outreachSendIntent: {
      findFirst: async () =>
        opts.existingIntentId ? { id: opts.existingIntentId } : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        orderLog.push('intent-commit');
        createdIntents.push(data);
        return { id: 'intent-1' };
      },
    },
    outreachDelivery: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.duplicateDelivery) {
          const e = new Error('unique violation') as Error & { code?: string };
          e.code = 'P2002';
          throw e;
        }
        orderLog.push('delivery-commit');
        createdDeliveries.push(data);
        return { id: 'del-1' };
      },
    },
  };

  const service = Object.create(OutreachSendIntentService.prototype) as OutreachSendIntentService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.staleMs = 120_000;
  patch.sweepMs = 5_000;
  patch.versionedOutreach = true;
  patch.externalSendV2Required = opts.v2Required ?? false;
  patch.prisma = {
    withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx),
    withSystem: (fn: (t: unknown) => unknown) => fn(tx),
  };
  patch.engagement = {
    findCampaignSendConnection: async () => ({ id: 'conn-1', provider: 'google_workspace' }),
    resolveSenderSignatureHtml: async () => ({
      appendSignature: false,
      signatureHtml: '',
      senderEmail: 'me@capiro.ai',
      senderFirstName: 'Neo',
    }),
    readAttachmentBytes: async () => Buffer.from('bytes'),
  };
  patch.mailSender = {
    sendMail: async () => {
      orderLog.push('provider-call');
      counters.providerCalls++;
      return { ok: true, provider: 'gmail', providerMessageId: 'gm-1', correlationId: 'corr-1' };
    },
  };

  return {
    service,
    get providerCalls() {
      return counters.providerCalls;
    },
    createdIntents,
    createdDeliveries,
    orderLog,
  } as IntentHarness;
}

const intentInput = {
  outreachRecordId: 'rec-1',
  requestKey: 'req-key-0001',
  senderConnectionId: 'conn-1',
  draftVersionIds: ['v-1'],
};

describe('createIntent — commit before any provider call', () => {
  test('the intent and its delivery are committed and NO provider call is made', async () => {
    const h = makeIntentHarness({});
    const out = await h.service.createIntent(ctx, intentInput);
    expect(out).toEqual({ intentId: 'intent-1', deduped: false });
    expect(h.orderLog).toEqual(['intent-commit', 'delivery-commit']);
    // The whole point: creating an intent contacts no provider.
    expect(h.providerCalls).toBe(0);
  });

  test('the delivery stores the EXACT rendered text and an idempotency key', async () => {
    const h = makeIntentHarness({});
    await h.service.createIntent(ctx, intentInput);
    const delivery = h.createdDeliveries[0]!;
    expect(delivery.renderedSubject).toBe('Subject');
    expect(String(delivery.renderedBody)).toContain('Body');
    expect(String(delivery.idempotencyKey)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(delivery.status).toBe('pending');
    expect(delivery.draftVersionId).toBe('v-1');
  });

  test('a DUPLICATE request key returns the existing intent and creates nothing', async () => {
    const h = makeIntentHarness({ existingIntentId: 'intent-existing' });
    const out = await h.service.createIntent(ctx, intentInput);
    expect(out).toEqual({ intentId: 'intent-existing', deduped: true });
    expect(h.createdIntents).toHaveLength(0);
    expect(h.createdDeliveries).toHaveLength(0);
    expect(h.providerCalls).toBe(0);
  });

  test('the SAME exact delivery under a NEW request key is refused (409), not re-sent', async () => {
    const h = makeIntentHarness({ duplicateDelivery: true });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, requestKey: 'different-key-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.providerCalls).toBe(0);
  });
});

describe('createIntent — refuses anything not cleared to send', () => {
  test('a HELD version is refused', async () => {
    const h = makeIntentHarness({ versionAudit: 'held', versionApproval: 'pending' });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('an audit-UNAVAILABLE version is refused', async () => {
    const h = makeIntentHarness({ versionAudit: 'unavailable', versionApproval: 'pending' });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test('a SUPERSEDED version (not current for its artifact) is refused', async () => {
    const h = makeIntentHarness({ versionCurrent: 1, artifactCurrent: 3 });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  test("another user's draft is a 404 — existence is not disclosed", async () => {
    const h = makeIntentHarness({ recordOwner: 'someone-else' });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('the v1-prompt gate blocks a REAL send but allows a test send', async () => {
    const real = makeIntentHarness({ v2Required: true, promptSpecVersion: 'v1' });
    await expect(real.service.createIntent(ctx, intentInput)).rejects.toThrow(/legacy prompt/i);

    const test = makeIntentHarness({ v2Required: true, promptSpecVersion: 'v1' });
    await expect(
      test.service.createIntent(ctx, { ...intentInput, testMode: true }),
    ).resolves.toEqual({ intentId: 'intent-1', deduped: false });
  });

  test('an OVERSIZED attachment is rejected BEFORE the intent exists (never silently skipped)', async () => {
    const h = makeIntentHarness({ attachmentByteSize: 5 * 1024 * 1024 });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/3 MB/i);
    expect(h.createdIntents).toHaveLength(0);
    expect(h.providerCalls).toBe(0);
  });

  test('duplicate version ids in one request are rejected', async () => {
    const h = makeIntentHarness({});
    await expect(
      h.service.createIntent(ctx, { ...intentInput, draftVersionIds: ['v-1', 'v-1'] }),
    ).rejects.toThrow(/duplicate/i);
  });

  test('a too-short request key is rejected', async () => {
    const h = makeIntentHarness({});
    await expect(h.service.createIntent(ctx, { ...intentInput, requestKey: 'short' })).rejects.toThrow(
      /8/,
    );
  });
});

// ── worker: at-most-once ─────────────────────────────────────────────────────

interface WorkerHarness {
  service: OutreachSendIntentService;
  providerCalls: number;
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  claimGuardedOnPending: boolean;
}

function makeWorkerHarness(opts: {
  sendImpl?: () => Promise<unknown>;
  persistFailures?: number;
}): WorkerHarness {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const counters = { providerCalls: 0, persistAttempts: 0 };
  const state = { claimed: false, guarded: false };

  const tx = {
    outreachDelivery: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (data.status === 'sent') {
          counters.persistAttempts++;
          if (counters.persistAttempts <= (opts.persistFailures ?? 0)) {
            throw new Error('database write failed after provider acceptance');
          }
        }
        updates.push({ where, data });
        return { count: 1 };
      },
      findMany: async () => [{ status: 'sent' }],
    },
    $queryRaw: async () => {
      if (state.claimed) return [];
      state.claimed = true;
      state.guarded = true; // the SQL predicate is status='pending'
      return [
        {
          id: 'del-1',
          tenant_id: 't1',
          draft_version_id: 'v-1',
          generation_key: 'individual:a@x.com',
          correlation_id: 'corr-1',
          rendered_subject: 'Subject',
          rendered_body: 'Body',
          recipient_envelope_jsonb: { to: [{ email: 'a@x.com' }], cc: [], bcc: [] },
          attachment_manifest_jsonb: [],
          provider: 'gmail',
        },
      ];
    },
    outreachSendIntent: {
      findFirst: async () => ({
        id: 'intent-1',
        tenantId: 't1',
        userId: 'u1',
        senderConnectionId: 'conn-1',
        status: 'queued',
        testMode: true,
        outreachRecordId: 'rec-1',
        senderConnection: { id: 'conn-1', provider: 'google_workspace' },
      }),
      updateMany: async () => ({ count: 1 }),
    },
    outreachRecord: { updateMany: async () => ({ count: 1 }) },
  };

  const service = Object.create(OutreachSendIntentService.prototype) as OutreachSendIntentService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.staleMs = 120_000;
  patch.prisma = {
    withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx),
    withSystem: (fn: (t: unknown) => unknown) => fn(tx),
  };
  patch.engagement = { readAttachmentBytes: async () => Buffer.from('x') };
  patch.mailSender = {
    sendMail: async () => {
      counters.providerCalls++;
      if (opts.sendImpl) return opts.sendImpl();
      return { ok: true, provider: 'gmail', providerMessageId: 'gm-1', correlationId: 'corr-1' };
    },
  };

  return {
    service,
    get providerCalls() {
      return counters.providerCalls;
    },
    updates,
    get claimGuardedOnPending() {
      return state.guarded;
    },
  } as WorkerHarness;
}

describe('worker delivery — at-most-once', () => {
  test('a successful send claims first, then persists sent + provider ids', async () => {
    const h = makeWorkerHarness({});
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    expect(h.claimGuardedOnPending).toBe(true);
    expect(h.providerCalls).toBe(1);
    const sent = h.updates.find((u) => u.data.status === 'sent')!;
    expect(sent.data.providerMessageId).toBe('gm-1');
    expect(sent.data.acceptedAt).toBeInstanceOf(Date);
  });

  test('an AMBIGUOUS outcome becomes unknown, and is never reset to pending', async () => {
    const h = makeWorkerHarness({
      sendImpl: async () => {
        throw new AmbiguousMailSendError('timeout after body sent', 'corr-1', 'draft-9');
      },
    });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    const unknown = h.updates.find((u) => u.data.status === 'unknown')!;
    expect(unknown).toBeDefined();
    expect(unknown.data.errorCode).toBe('PROVIDER_OUTCOME_UNKNOWN');
    expect(unknown.data.providerDraftId).toBe('draft-9');
    // Exactly one provider call, and nothing was returned to 'pending'.
    expect(h.providerCalls).toBe(1);
    expect(h.updates.some((u) => u.data.status === 'pending')).toBe(false);
  });

  test('a clear provider rejection becomes failed with a SANITIZED code', async () => {
    const h = makeWorkerHarness({
      sendImpl: async () => {
        throw new Error('Gmail send failed (403): insufficient scope for user xyz');
      },
    });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    const failed = h.updates.find((u) => u.data.status === 'failed')!;
    expect(failed.data.errorCode).toBe('PROVIDER_FORBIDDEN');
    expect(h.providerCalls).toBe(1);
  });

  test('provider acceptance + a database failure RETRIES ONLY THE WRITE — never the send', async () => {
    const h = makeWorkerHarness({ persistFailures: 2 });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    // One provider call despite three persistence attempts.
    expect(h.providerCalls).toBe(1);
    expect(h.updates.some((u) => u.data.status === 'sent')).toBe(true);
  });
});

describe('worker reconciliation', () => {
  test('a stale claim becomes UNKNOWN, never pending', async () => {
    const captured: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const service = Object.create(OutreachSendIntentService.prototype) as OutreachSendIntentService;
    const patch = service as unknown as Record<string, unknown>;
    patch.staleMs = 1000;
    patch.logger = { warn: () => {}, error: () => {} };
    patch.prisma = {
      withSystem: (fn: (t: unknown) => unknown) =>
        fn({
          outreachDelivery: {
            updateMany: async (a: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              captured.push(a);
              return { count: 1 };
            },
          },
        }),
    };
    await (service as unknown as { reconcileStale(): Promise<void> }).reconcileStale();
    expect(captured).toHaveLength(1);
    // Only rows stuck in 'sending' are touched…
    expect(captured[0]!.where.status).toBe('sending');
    // …and they go to 'unknown'. 'pending' here would risk a duplicate email.
    expect(captured[0]!.data.status).toBe('unknown');
    expect(captured[0]!.data.status).not.toBe('pending');
  });
});
