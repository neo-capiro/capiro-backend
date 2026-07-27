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
  sendIntentRequestFingerprint,
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

/** Minimal shape of a TOCTOU-recheck row — a subset of the full version select. */
function toctouRow(
  overrides: Partial<{
    id: string;
    version: number;
    auditStatus: string;
    approvalStatus: string;
    artifactCurrentVersion: number;
    artifactCreatedByUserId: string;
    artifactOutreachRecordId: string;
  }> = {},
) {
  return {
    id: overrides.id ?? 'v-1',
    version: overrides.version ?? 1,
    auditStatus: overrides.auditStatus ?? 'passed',
    approvalStatus: overrides.approvalStatus ?? 'not_required',
    artifact: {
      currentVersion: overrides.artifactCurrentVersion ?? 1,
      createdByUserId: overrides.artifactCreatedByUserId ?? 'u1',
      outreachRecordId: overrides.artifactOutreachRecordId ?? 'rec-1',
    },
  };
}

function makeIntentHarness(opts: {
  existingIntentId?: string | null;
  /** requestFingerprint on the "existing" intent row. Defaults to a value that will NOT match a fresh computation — a test asserting a true dedupe must pass the matching value explicitly. */
  existingFingerprint?: string;
  versionAudit?: string;
  versionApproval?: string;
  versionCurrent?: number;
  artifactCurrent?: number;
  promptSpecVersion?: string | null;
  v2Required?: boolean;
  attachmentByteSize?: number | null;
  duplicateDelivery?: boolean;
  recordOwner?: string;
  recordStatus?: string;
  /** The version's OWN campaign — defaults to 'rec-1', matching the record being sent against. */
  versionRecordId?: string;
  /** A SECOND, independent version row appended alongside 'v-1' — lets a test build a genuinely mixed-campaign (or mixed-validity) multi-version request. */
  secondVersion?: Record<string, unknown>;
  /** If set, returned by the SECOND+ outreachDraftVersion.findMany call (the TOCTOU recheck) instead of the first call's row(s) — simulates something changing between the pre-transaction load and the commit. */
  toctouVersions?: unknown[];
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
      outreachRecordId: opts.versionRecordId ?? 'rec-1',
    },
  };

  let versionFindManyCalls = 0;

  const tx = {
    outreachRecord: {
      findFirst: async () => ({
        id: 'rec-1',
        createdByUserId: opts.recordOwner ?? 'u1',
        status: opts.recordStatus ?? 'draft',
      }),
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
      findMany: async () => {
        versionFindManyCalls++;
        // 1st call = loadSendableVersions (pre-transaction). 2nd+ = the TOCTOU
        // recheck inside the transaction — only diverges when a test supplies
        // toctouVersions, so every existing (pre-Phase-c) test is unaffected.
        if (versionFindManyCalls > 1 && opts.toctouVersions !== undefined) {
          return opts.toctouVersions;
        }
        return opts.secondVersion ? [versionRow, opts.secondVersion] : [versionRow];
      },
    },
    outreachSendIntent: {
      findFirst: async () =>
        opts.existingIntentId
          ? {
              id: opts.existingIntentId,
              requestFingerprint: opts.existingFingerprint ?? `sha256:${'0'.repeat(64)}`,
            }
          : null,
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

/** What createIntent will actually compute for the default fixture above — used to simulate a TRUE retry (matching fingerprint) versus a key reused for a different request. */
const DEFAULT_FINGERPRINT = sendIntentRequestFingerprint({
  tenantId: 't1',
  userId: 'u1',
  outreachRecordId: 'rec-1',
  senderConnectionId: 'conn-1',
  versionIds: ['v-1'],
  manifest: [],
  appendSignature: false,
  testMode: false,
});

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

  test('a DUPLICATE request key with the SAME payload returns the existing intent and creates nothing', async () => {
    const h = makeIntentHarness({
      existingIntentId: 'intent-existing',
      existingFingerprint: DEFAULT_FINGERPRINT,
    });
    const out = await h.service.createIntent(ctx, intentInput);
    expect(out).toEqual({ intentId: 'intent-existing', deduped: true });
    expect(h.createdIntents).toHaveLength(0);
    expect(h.createdDeliveries).toHaveLength(0);
    expect(h.providerCalls).toBe(0);
  });

  test('the intent row PERSISTS its own requestFingerprint', async () => {
    const h = makeIntentHarness({});
    await h.service.createIntent(ctx, intentInput);
    expect(h.createdIntents[0]!.requestFingerprint).toBe(DEFAULT_FINGERPRINT);
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

// ── Phase c: campaign binding + request-key integrity ───────────────────────

describe('createIntent — parent record must remain a draft (plan §3.c1)', () => {
  test('a SENT campaign refuses a new intent (409, not 404 — it exists and is owned)', async () => {
    const h = makeIntentHarness({ recordStatus: 'sent' });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  test('a FAILED campaign refuses a new intent', async () => {
    const h = makeIntentHarness({ recordStatus: 'failed' });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toThrow(/no longer a draft/i);
  });

  test('a DRAFT campaign (the default) is unaffected', async () => {
    const h = makeIntentHarness({});
    await expect(h.service.createIntent(ctx, intentInput)).resolves.toEqual({
      intentId: 'intent-1',
      deduped: false,
    });
  });
});

describe('createIntent — versions must belong to the requested campaign (plan §3.c2/c4)', () => {
  test('a version from a DIFFERENT one of the caller\'s own campaigns is refused as 404, not disclosed as "wrong campaign"', async () => {
    const h = makeIntentHarness({ versionRecordId: 'rec-OTHER' });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('mixing that cross-record version alongside a VALID in-record one refuses the WHOLE intent', async () => {
    // A genuinely mixed request: 'v-1' legitimately belongs to rec-1, 'v-2'
    // belongs to rec-OTHER. Neither is dropped silently — the whole intent
    // is refused, because rollUpIntent can only mirror a delivery's outcome
    // onto ONE OutreachRecord.
    const h = makeIntentHarness({
      secondVersion: {
        id: 'v-2',
        version: 1,
        subject: 'Subject 2',
        body: 'Body 2',
        auditStatus: 'passed',
        approvalStatus: 'not_required',
        promptSpecVersion: 'v2.1',
        artifact: {
          id: 'art-2',
          currentVersion: 1,
          generationKey: 'individual:b@x.com',
          recipientKey: 'b@x.com',
          recipientSnapshot: { email: 'b@x.com', name: 'B', cc: [], bcc: [] },
          createdByUserId: 'u1',
          outreachRecordId: 'rec-OTHER',
        },
      },
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, draftVersionIds: ['v-1', 'v-2'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.createdIntents).toHaveLength(0);
  });
});

describe('createIntent — TOCTOU recheck inside the transaction (plan §3.c3)', () => {
  test('a version that vanished between load and commit (row-count mismatch) rejects', async () => {
    const h = makeIntentHarness({ toctouVersions: [] });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toThrow(
      /changed while the send was being prepared/i,
    );
    expect(h.createdIntents).toHaveLength(0);
  });

  test('ownership changing between load and commit rejects, even though the pre-transaction check passed', async () => {
    const h = makeIntentHarness({
      toctouVersions: [toctouRow({ artifactCreatedByUserId: 'someone-else' })],
    });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toThrow(
      /changed while the send was being prepared/i,
    );
  });

  test('the campaign binding changing between load and commit rejects', async () => {
    const h = makeIntentHarness({
      toctouVersions: [toctouRow({ artifactOutreachRecordId: 'rec-OTHER' })],
    });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toThrow(
      /changed while the send was being prepared/i,
    );
  });

  test('a version superseded only by the time of the TOCTOU recheck rejects', async () => {
    const h = makeIntentHarness({
      toctouVersions: [toctouRow({ version: 1, artifactCurrentVersion: 2 })],
    });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  test('a version held (not sendable) only by the time of the TOCTOU recheck rejects', async () => {
    const h = makeIntentHarness({
      toctouVersions: [toctouRow({ auditStatus: 'held', approvalStatus: 'pending' })],
    });
    await expect(h.service.createIntent(ctx, intentInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  test('when nothing changed, the TOCTOU recheck is a silent no-op and the intent commits', async () => {
    const h = makeIntentHarness({ toctouVersions: [toctouRow()] });
    await expect(h.service.createIntent(ctx, intentInput)).resolves.toEqual({
      intentId: 'intent-1',
      deduped: false,
    });
  });
});

describe('sendIntentRequestFingerprint (plan §3.c6)', () => {
  const base = {
    tenantId: 't1',
    userId: 'u1',
    outreachRecordId: 'rec-1',
    senderConnectionId: 'conn-1',
    versionIds: ['v-1'],
    manifest: [],
    appendSignature: false,
    testMode: false,
  };

  test('is stable and looks like a real sha256 fingerprint', () => {
    expect(sendIntentRequestFingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sendIntentRequestFingerprint(base)).toBe(sendIntentRequestFingerprint(base));
  });

  test('version id order does not change it, but the SET of versions does', () => {
    const a = sendIntentRequestFingerprint({ ...base, versionIds: ['v-1', 'v-2'] });
    const b = sendIntentRequestFingerprint({ ...base, versionIds: ['v-2', 'v-1'] });
    expect(a).toBe(b);
    expect(sendIntentRequestFingerprint({ ...base, versionIds: ['v-1', 'v-3'] })).not.toBe(a);
  });

  test('every one of tenant, user, parent record, mailbox, signature choice, and test mode changes it', () => {
    const a = sendIntentRequestFingerprint(base);
    expect(sendIntentRequestFingerprint({ ...base, tenantId: 't2' })).not.toBe(a);
    expect(sendIntentRequestFingerprint({ ...base, userId: 'u2' })).not.toBe(a);
    expect(sendIntentRequestFingerprint({ ...base, outreachRecordId: 'rec-2' })).not.toBe(a);
    expect(sendIntentRequestFingerprint({ ...base, senderConnectionId: 'conn-2' })).not.toBe(a);
    expect(sendIntentRequestFingerprint({ ...base, appendSignature: true })).not.toBe(a);
    expect(sendIntentRequestFingerprint({ ...base, testMode: true })).not.toBe(a);
  });

  test('an attachment manifest change (id, name, type, or size) changes it', () => {
    const a = sendIntentRequestFingerprint(base);
    const withAttachment = (
      over: Partial<{ id: string; fileName: string; contentType: string; byteSize: number }>,
    ) =>
      sendIntentRequestFingerprint({
        ...base,
        manifest: [{ id: 'att-1', fileName: 'f.pdf', contentType: 'application/pdf', byteSize: 10, ...over }],
      });
    const withDefault = withAttachment({});
    expect(withDefault).not.toBe(a);
    expect(withAttachment({ id: 'att-2' })).not.toBe(withDefault);
    expect(withAttachment({ fileName: 'g.pdf' })).not.toBe(withDefault);
    expect(withAttachment({ contentType: 'application/octet-stream' })).not.toBe(withDefault);
    expect(withAttachment({ byteSize: 11 })).not.toBe(withDefault);
  });

  test('attachment order does not matter, only the set', () => {
    const att1 = { id: 'att-1', fileName: 'a', contentType: 'application/pdf', byteSize: 1 };
    const att2 = { id: 'att-2', fileName: 'b', contentType: 'application/pdf', byteSize: 2 };
    const a = sendIntentRequestFingerprint({ ...base, manifest: [att1, att2] });
    const b = sendIntentRequestFingerprint({ ...base, manifest: [att2, att1] });
    expect(a).toBe(b);
  });
});

describe('createIntent — request-key reuse with a DIFFERENT payload (plan §3.c7)', () => {
  test('same key, unrelated stored fingerprint → 409 OUTREACH_REQUEST_KEY_REUSED with a structured error body', async () => {
    const h = makeIntentHarness({
      existingIntentId: 'intent-existing',
      existingFingerprint: 'sha256:' + 'f'.repeat(64), // deliberately NOT DEFAULT_FINGERPRINT
    });
    try {
      await h.service.createIntent(ctx, intentInput);
      throw new Error('expected createIntent to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const response = (e as ConflictException).getResponse() as Record<string, unknown>;
      expect(response.error).toBe('OUTREACH_REQUEST_KEY_REUSED');
    }
    expect(h.createdIntents).toHaveLength(0);
    expect(h.providerCalls).toBe(0);
  });

  test('the exact same request under the SAME key genuinely dedupes when the fingerprint matches', async () => {
    const h = makeIntentHarness({
      existingIntentId: 'intent-existing',
      existingFingerprint: DEFAULT_FINGERPRINT,
    });
    await expect(h.service.createIntent(ctx, intentInput)).resolves.toEqual({
      intentId: 'intent-existing',
      deduped: true,
    });
  });

  test('reusing a key for what is now a TEST send does not silently dedupe the earlier real request', async () => {
    const h = makeIntentHarness({
      existingIntentId: 'intent-existing',
      existingFingerprint: DEFAULT_FINGERPRINT, // matches the ORIGINAL (non-test) request only
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, testMode: true }),
    ).rejects.toThrow(/different send request/i);
  });

  test('reusing a key for a DIFFERENT set of draft versions does not silently dedupe', async () => {
    const h = makeIntentHarness({
      existingIntentId: 'intent-existing',
      existingFingerprint: DEFAULT_FINGERPRINT,
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, draftVersionIds: ['v-2'] }),
    ).rejects.toThrow(/different send request/i);
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
