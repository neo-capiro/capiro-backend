// Engagement Phase 0 (plan §3.d2) — EVERY raw-body external-send path closes
// under ENGAGEMENT_VERSIONED_OUTREACH.
//
// sendBatchEmails() was gated when Phase 0 landed, but it is not the only route
// that mails caller-supplied text: `sendCampaign()` re-sends whatever free text
// `PATCH /outreach/:id` stored on the record, and `sendCampaignEmails()` does the
// same for the separate EngagementCampaign tables. Both delivered to real
// recipients with no immutable version, no audit verdict, no durable intent, and
// persisted the outcome only AFTER the provider had accepted.
//
// Leaving either open would mean the boundary could be walked around by saving
// text and calling a different endpoint — so this spec pins that a REAL send is
// refused on all three, and that the two self-only test paths stay usable during
// the cutover.

import { describe, expect, test } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as TenantContext;

/**
 * A service whose only wired collaborator is the mail sender, so "did anything
 * reach a provider?" is directly observable. Every data read throws: if a gate
 * lets a call through, the test fails loudly rather than silently passing on a
 * mock that happened to return nothing.
 */
function makeService(versionedOutreach: boolean) {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 1: generateBatchEmails branches on this.gateway.enabled before doing
  // anything else. These specs build the service with Object.create (no
  // constructor), so the injected dependency has to be supplied here. OFF selects
  // the legacy path, which is what these specs exercise.
  patch.gateway = { enabled: false };
  let sendCalls = 0;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.versionedOutreach = versionedOutreach;
  patch.mailSender = {
    sendMail: async () => {
      sendCalls++;
      return { ok: true, provider: 'microsoft_graph', correlationId: 'c1' };
    },
  };
  patch.prisma = {
    withTenant: () => {
      throw new Error('DB READ REACHED — the gate did not refuse the send');
    },
  };
  // Any of these being reached means the gate came too late to matter.
  patch.getOutreachRecord = async () => {
    throw new Error('getOutreachRecord REACHED — the gate did not refuse the send');
  };
  patch.getCampaign = async () => {
    throw new Error('getCampaign REACHED — the gate did not refuse the send');
  };
  patch.findCampaignSendConnection = async () => {
    throw new Error('connection resolution REACHED — the gate did not refuse the send');
  };
  return { service, sendCalls: () => sendCalls };
}

describe('legacy raw-body send paths refuse a REAL send when versioning is on', () => {
  test('sendCampaign() (POST /outreach/:id/send-campaign) is refused', async () => {
    const h = makeService(true);
    const caught = await h.service.sendCampaign(ctx, 'rec-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).message).toMatch(/audited draft version/i);
    expect(h.sendCalls()).toBe(0);
  });

  test('sendCampaignEmails() (POST /campaigns/:id/send) is refused', async () => {
    const h = makeService(true);
    const caught = await h.service.sendCampaignEmails(ctx, 'camp-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).message).toMatch(/audited draft version/i);
    expect(h.sendCalls()).toBe(0);
  });

  test('sendBatchEmails() real send is refused (the originally-gated path, pinned)', async () => {
    const h = makeService(true);
    const caught = await h.service
      .sendBatchEmails(ctx, {
        recipients: [{ email: 'target@house.gov' }],
        drafts: [{ recipientId: 'target@house.gov', subject: 'S', body: 'B' }],
      } as Parameters<EngagementService['sendBatchEmails']>[1])
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(h.sendCalls()).toBe(0);
  });

  test('the refusal happens BEFORE any record/connection read, not after', async () => {
    // makeService throws on every read, so a BadRequestException (rather than the
    // 'REACHED' Error) proves the gate is the very first thing in each method.
    const h = makeService(true);
    for (const call of [
      () => h.service.sendCampaign(ctx, 'rec-1'),
      () => h.service.sendCampaignEmails(ctx, 'camp-1'),
    ]) {
      const caught = await call().catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as Error).message).not.toMatch(/REACHED/);
    }
  });
});

describe('with versioning OFF the legacy paths still run (no premature removal)', () => {
  test('sendCampaign() proceeds past the gate into its normal work', async () => {
    const h = makeService(false);
    const caught = await h.service.sendCampaign(ctx, 'rec-1').catch((e: unknown) => e);
    // It got through the gate and hit the (deliberately throwing) record read,
    // which is exactly the pre-Phase-0 behaviour this flag preserves.
    expect((caught as Error).message).toMatch(/REACHED/);
  });

  test('sendCampaignEmails() proceeds past the gate into its normal work', async () => {
    const h = makeService(false);
    const caught = await h.service.sendCampaignEmails(ctx, 'camp-1').catch((e: unknown) => e);
    expect((caught as Error).message).toMatch(/REACHED/);
  });
});
