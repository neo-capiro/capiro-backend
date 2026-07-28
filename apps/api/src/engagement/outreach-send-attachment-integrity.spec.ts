// Remediation plan §3.d — attachment identity and readiness are part of the
// send boundary, not an afterthought.
//
// Three moments matter, and this file tests all three:
//   • resolveAttachments() (OutreachSendIntentService) — BEFORE the intent
//     exists. Anything not usable (scan/lifecycle status, a byte/size/type
//     mismatch against what was verified, or oversized) refuses the WHOLE
//     intent. Nothing is silently omitted.
//   • loadManifestBytes() — immediately BEFORE the provider call, reached via
//     the worker's processIntent(). A clean verdict at intent-creation time is
//     not a permanent clearance: this re-reads the row fresh and re-verifies
//     it against the IMMUTABLE manifest captured at creation time.
//   • sendBatchEmails() (EngagementService, plan §3.d6) — the legacy path
//     predates the scan/lifecycle gate entirely; it must refuse the same way.

import { describe, expect, test } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';
import { EngagementService } from './engagement.service.js';
import { AttachmentContentService } from './attachment-content.service.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

const attachmentContent = new AttachmentContentService();
const DEFAULT_BYTES = Buffer.from('the real file bytes');
const DEFAULT_SHA256 = attachmentContent.sha256(DEFAULT_BYTES);

const intentInput = {
  outreachRecordId: 'rec-1',
  requestKey: 'req-key-0001',
  senderConnectionId: 'conn-1',
  draftVersionIds: ['v-1'],
};

// ── creation-time: resolveAttachments (plan §3.d3) ──────────────────────────

/** A row shaped like a real EngagementAttachment select — every field the readiness gate needs. */
function attachmentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'att-1',
    fileName: 'contract.pdf',
    contentType: 'application/pdf',
    byteSize: DEFAULT_BYTES.length,
    s3Key: 'k1',
    lifecycleStatus: 'ready',
    verifiedContentType: null,
    calculatedSha256: DEFAULT_SHA256,
    scanProvider: 'test',
    scanStatus: 'clean',
    scanResultAt: null,
    ...over,
  };
}

function makeCreateHarness(opts: {
  attachmentRow?: Record<string, unknown>;
  attachmentRows?: Array<Record<string, unknown>>;
  readBytes?: (s3Key: string) => Promise<Buffer>;
  scanRequired?: boolean;
}) {
  const versionRow = {
    id: 'v-1',
    version: 1,
    subject: 'Subject',
    body: 'Body',
    auditStatus: 'passed',
    approvalStatus: 'not_required',
    promptSpecVersion: 'v2.1',
    artifact: {
      id: 'art-1',
      currentVersion: 1,
      generationKey: 'individual:a@x.com',
      recipientKey: 'a@x.com',
      recipientSnapshot: { email: 'a@x.com', name: 'A', cc: [], bcc: [] },
      createdByUserId: 'u1',
      outreachRecordId: 'rec-1',
    },
  };
  const createdIntents: Array<Record<string, unknown>> = [];
  const createdDeliveries: Array<Record<string, unknown>> = [];

  const tx = {
    outreachRecord: {
      findFirst: async () => ({ id: 'rec-1', createdByUserId: 'u1', status: 'draft' }),
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
      findMany: async () => opts.attachmentRows ?? [opts.attachmentRow ?? attachmentRow()],
    },
    outreachDraftVersion: { findMany: async () => [versionRow] },
    outreachSendIntent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdIntents.push(data);
        return { id: 'intent-1' };
      },
    },
    outreachDelivery: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdDeliveries.push(data);
        return { id: 'del-1' };
      },
    },
  };

  const service = Object.create(OutreachSendIntentService.prototype) as OutreachSendIntentService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.versionedOutreach = true;
  patch.externalSendV2Required = false;
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
    readAttachmentBytes: opts.readBytes ?? (async () => DEFAULT_BYTES),
  };
  patch.mailSender = { sendMail: async () => ({ ok: true, provider: 'gmail', correlationId: 'c' }) };
  patch.attachmentContent = attachmentContent;
  patch.attachmentScanner = { scanRequired: opts.scanRequired ?? false };

  return { service, createdIntents, createdDeliveries };
}

describe('resolveAttachments — usable attachments (plan §3.d3)', () => {
  test('a clean, scanned attachment is included with a full manifest snapshot', async () => {
    const h = makeCreateHarness({});
    await h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] });
    const manifest = h.createdDeliveries[0]!.attachmentManifest as unknown as Array<
      Record<string, unknown>
    >;
    expect(manifest).toEqual([
      {
        id: 'att-1',
        fileName: 'contract.pdf',
        contentType: 'application/pdf',
        byteSize: DEFAULT_BYTES.length,
        verifiedContentType: null,
        sha256: DEFAULT_SHA256,
        lifecycleStatus: 'ready',
        scanStatus: 'clean',
        scanProvider: 'test',
        scanResultAt: null,
      },
    ]);
  });

  test('EXACT bytes: the manifest hash is the real sha256 of what will be sent, not a passthrough of a stored claim', async () => {
    const h = makeCreateHarness({
      attachmentRow: attachmentRow({ calculatedSha256: null }), // legacy row, never hashed before
    });
    await h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] });
    const manifest = h.createdDeliveries[0]!.attachmentManifest as unknown as Array<
      Record<string, unknown>
    >;
    expect(manifest[0]!.sha256).toBe(DEFAULT_SHA256);
  });

  test('scanner-not-required is usable and DISCLOSED in the manifest scan status, never labeled clean', async () => {
    const h = makeCreateHarness({
      attachmentRow: attachmentRow({ scanStatus: 'scanner_not_required', calculatedSha256: null }),
    });
    await h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] });
    const manifest = h.createdDeliveries[0]!.attachmentManifest as unknown as Array<
      Record<string, unknown>
    >;
    expect(manifest[0]!.scanStatus).toBe('scanner_not_required');
  });
});

describe('resolveAttachments — refuses the WHOLE intent, never silently omits (plan §3.d3)', () => {
  const expectRefused = async (
    row: Record<string, unknown>,
    pattern: RegExp,
    scanRequired = false,
  ) => {
    const h = makeCreateHarness({ attachmentRow: row, scanRequired });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(pattern);
    expect(h.createdIntents).toHaveLength(0);
    expect(h.createdDeliveries).toHaveLength(0);
  };

  // A 'threat' scan verdict alone is only BLOCKING when scanning is required —
  // readiness() intentionally treats scan-required as the on/off switch for the
  // whole scan-status gate (Phase 1 §3.h1 design, unchanged by this plan: "when
  // scanning is NOT required... otherwise the feature would be dead in every
  // environment without a scanner"). A confirmed threat is ALSO reflected as
  // lifecycleStatus='blocked' in the real system (see the schema's own
  // lifecycle_status comment: "'blocked' (threat/unsupported/access_denied/
  // failed)"), which IS unconditional — covered by the BLOCKED test below.
  test('a THREAT-flagged file is refused when scanning is required', () =>
    expectRefused(attachmentRow({ scanStatus: 'threat' }), /cannot be sent/i, true));

  test('a QUARANTINED file (scan pending) is refused when scan is required', async () => {
    const h = makeCreateHarness({
      attachmentRow: attachmentRow({ lifecycleStatus: 'quarantined', scanStatus: null }),
      scanRequired: true,
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/cannot be sent/i);
  });

  test('a BLOCKED file is refused regardless of scan-required', () =>
    expectRefused(
      attachmentRow({ lifecycleStatus: 'blocked', scanStatus: 'threat' }),
      /malware|blocked/i,
      false,
    ));

  test('NEVER SCANNED is refused when scanning is required', async () => {
    const h = makeCreateHarness({
      attachmentRow: attachmentRow({ scanStatus: null }),
      scanRequired: true,
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/cannot be sent/i);
  });

  test('DELETED (row missing entirely) is refused, not silently sent without it', async () => {
    const h = makeCreateHarness({ attachmentRows: [] });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/could not be found/i);
  });

  test('a HASH CHANGE since verification (bytes in S3 differ from what was scanned) is refused', async () => {
    const h = makeCreateHarness({
      attachmentRow: attachmentRow({ calculatedSha256: 'a'.repeat(64) }), // will not match DEFAULT_BYTES' real hash
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/content changed since it was verified/i);
  });

  test('a SIZE MISMATCH against the stored byteSize is refused', async () => {
    const h = makeCreateHarness({ attachmentRow: attachmentRow({ byteSize: 999 }) });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/size changed since it was verified/i);
  });

  test('a MIME conflict (declared PDF, actual bytes are a JPEG) is refused', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const h = makeCreateHarness({
      attachmentRow: attachmentRow({
        byteSize: jpeg.length,
        calculatedSha256: attachmentContent.sha256(jpeg),
      }),
      readBytes: async () => jpeg,
    });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toThrow(/type does not match/i);
  });

  test('an OVERSIZED file is refused (pre-existing d0 behavior, unchanged)', async () => {
    const big = 4 * 1024 * 1024;
    const h = makeCreateHarness({ attachmentRow: attachmentRow({ byteSize: big }) });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('no silent omission: ONE bad file among several refuses the WHOLE batch, not just the bad one', async () => {
    const good = attachmentRow({ id: 'att-1', fileName: 'good.pdf' });
    const bad = attachmentRow({
      id: 'att-2',
      fileName: 'threat.pdf',
      lifecycleStatus: 'blocked',
      scanStatus: 'threat',
    });
    const h = makeCreateHarness({ attachmentRows: [good, bad] });
    await expect(
      h.service.createIntent(ctx, { ...intentInput, attachmentIds: ['att-1', 'att-2'] }),
    ).rejects.toThrow(/threat\.pdf/);
    expect(h.createdDeliveries).toHaveLength(0);
  });
});

// ── pre-provider-submission: loadManifestBytes via the worker (plan §3.d4) ──

function makeDeliverHarness(opts: {
  manifest: Array<Record<string, unknown>>;
  attachmentRows: Array<Record<string, unknown>>;
  readBytes?: (s3Key: string) => Promise<Buffer>;
}) {
  const state = { claimed: false };
  const updates: Array<{ data: Record<string, unknown> }> = [];
  let providerCalls = 0;

  const tx = {
    $queryRaw: async () => {
      if (state.claimed) return [];
      state.claimed = true;
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
          attachment_manifest_jsonb: opts.manifest,
          provider: 'gmail',
        },
      ];
    },
    engagementAttachment: { findMany: async () => opts.attachmentRows },
    outreachDelivery: {
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push({ data });
        return { count: 1 };
      },
      findMany: async () => [{ status: 'failed' }],
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
  patch.engagement = { readAttachmentBytes: opts.readBytes ?? (async () => DEFAULT_BYTES) };
  patch.attachmentContent = attachmentContent;
  patch.attachmentScanner = { scanRequired: false };
  patch.mailSender = {
    sendMail: async () => {
      providerCalls++;
      return { ok: true, provider: 'gmail', providerMessageId: 'gm-1', correlationId: 'corr-1' };
    },
  };

  return {
    service,
    updates,
    get providerCalls() {
      return providerCalls;
    },
  };
}

/** The immutable manifest entry captured at (simulated) intent-creation time. */
function manifestEntry(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'att-1',
    fileName: 'contract.pdf',
    contentType: 'application/pdf',
    byteSize: DEFAULT_BYTES.length,
    verifiedContentType: null,
    sha256: DEFAULT_SHA256,
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    scanProvider: 'test',
    scanResultAt: null,
    ...over,
  };
}

describe('loadManifestBytes — reverified immediately before the provider call (plan §3.d4)', () => {
  test('unchanged bytes: the provider IS called and the delivery is not blocked', async () => {
    const h = makeDeliverHarness({
      manifest: [manifestEntry()],
      attachmentRows: [attachmentRow()],
    });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    expect(h.providerCalls).toBe(1);
    expect(h.updates.some((u) => u.data.status === 'sent')).toBe(true);
  });

  test('DELETED after intent creation: blocks the send, delivery FAILS with ATTACHMENT_UNAVAILABLE, no provider call', async () => {
    const h = makeDeliverHarness({
      manifest: [manifestEntry()],
      attachmentRows: [], // row is gone
    });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    expect(h.providerCalls).toBe(0);
    const failed = h.updates.find((u) => u.data.status === 'failed');
    expect(failed?.data.errorCode).toBe('ATTACHMENT_UNAVAILABLE');
  });

  test('SCAN STATUS CHANGED to threat after intent creation: blocks the send, no provider call', async () => {
    const h = makeDeliverHarness({
      manifest: [manifestEntry()],
      // A confirmed threat verdict is reflected as lifecycleStatus='blocked' in
      // the real system (the schema's own lifecycle_status comment), which
      // readiness() treats as unconditionally unusable regardless of the
      // scan-required flag.
      attachmentRows: [attachmentRow({ lifecycleStatus: 'blocked', scanStatus: 'threat' })],
    });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    expect(h.providerCalls).toBe(0);
    const failed = h.updates.find((u) => u.data.status === 'failed');
    expect(failed?.data.errorCode).toBe('ATTACHMENT_UNAVAILABLE');
  });

  test('BYTES CHANGED since the manifest was captured (same id/name/type/size, different content): blocks the send', async () => {
    const swapped = Buffer.from('a completely different file, same declared size padding!!');
    const h = makeDeliverHarness({
      manifest: [manifestEntry({ byteSize: swapped.length })],
      attachmentRows: [attachmentRow({ byteSize: swapped.length })],
      readBytes: async () => swapped,
    });
    await (h.service as unknown as { processIntent(id: string): Promise<void> }).processIntent(
      'intent-1',
    );
    expect(h.providerCalls).toBe(0);
    const failed = h.updates.find((u) => u.data.status === 'failed');
    expect(failed?.data.errorCode).toBe('ATTACHMENT_UNAVAILABLE');
    expect(String(failed?.data.errorMessage)).toMatch(/content changed/i);
  });
});

// ── legacy path: sendBatchEmails (plan §3.d6) ───────────────────────────────

function makeLegacyBatchHarness(opts: { attachmentRows: Array<Record<string, unknown>> }) {
  let providerCalls = 0;
  const tx = {
    user: {
      findUnique: async () => ({
        email: 'me@capiro.ai',
        firstName: 'Neo',
        emailSignatureHtml: null,
        emailSignatureEnabled: false,
      }),
    },
    engagementAttachment: { findMany: async () => opts.attachmentRows },
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.versionedOutreach = false; // legacy path still live (flags unchanged by this plan)
  patch.prisma = { withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx) };
  patch.attachmentContent = attachmentContent;
  patch.scanner = { scanRequired: false };
  patch.findCampaignSendConnection = async () => ({ id: 'conn-1', provider: 'google_workspace' });
  patch.readAttachmentBytes = async () => DEFAULT_BYTES;
  patch.mailSender = {
    sendMail: async () => {
      providerCalls++;
      return { ok: true, provider: 'gmail', correlationId: 'c1' };
    },
  };
  return {
    service,
    get providerCalls() {
      return providerCalls;
    },
  };
}

const batchInput = {
  senderConnectionId: 'conn-1',
  testMode: true,
  recipients: [{ id: 'r1', email: 'a@x.com', name: 'A' }],
  drafts: [{ recipientId: 'r1', subject: 'Hi', body: 'Body' }],
  attachmentIds: ['att-1'],
};

describe('sendBatchEmails — the legacy path enforces the SAME readiness policy (plan §3.d6)', () => {
  test('a THREAT-flagged attachment refuses the WHOLE send, not just a silent skip', async () => {
    const h = makeLegacyBatchHarness({
      attachmentRows: [attachmentRow({ lifecycleStatus: 'blocked', scanStatus: 'threat' })],
    });
    await expect(h.service.sendBatchEmails(ctx, batchInput)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(h.providerCalls).toBe(0);
  });

  test('a clean attachment still sends normally (no false-positive regression)', async () => {
    const h = makeLegacyBatchHarness({ attachmentRows: [attachmentRow()] });
    const result = await h.service.sendBatchEmails(ctx, batchInput);
    expect(result.sent).toBe(1);
    expect(h.providerCalls).toBe(1);
  });
});
