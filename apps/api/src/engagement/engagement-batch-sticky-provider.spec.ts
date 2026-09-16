// Campaign-sticky provider (M2 / W3.2). A batch resolves the pinned
// provider/model ONCE through the gateway before fanning out, so one campaign
// can never split between two provider "voices". This proves the batch path
// uses the ONE identity resolved at the top for every recipient — recipients
// never re-resolve credentials per slot.
//
// The Phase 26 cutover routes batch generation through the governed gateway
// unconditionally, so the spy sits on gateway.generate and asserts the pinned
// identity every recipient's request carries is the campaign-invariant one.
//
// Prototype-stub pattern (mirrors engagement-batch-group.spec.ts).

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

/**
 * Captures the pinned identity each recipient's request carries. When
 * `failFirstRecipient` is set, the FIRST generate() call returns a gateway
 * outcome:'error' (the Phase 26 shape of a per-recipient drafting failure);
 * later slots still draft 'ready' — proving a failed slot cannot un-pin or
 * re-resolve the campaign identity.
 */
function makeService(opts?: { failFirstRecipient?: boolean }): {
  service: EngagementService;
  pinnedSeen: Array<Record<string, unknown>>;
  resolveCalls: () => number;
} {
  const pinnedSeen: Array<Record<string, unknown>> = [];
  let resolveCalls = 0;
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 26 cutover: batch generation runs through the governed gateway
  // unconditionally; stub its two entry points the batch path uses.
  patch.gateway = {
    resolvePinnedIdentity: async () => {
      resolveCalls += 1;
      return {
        creds: [{ provider: 'anthropic', apiKey: 'test-key', model: 'm' }],
        pinned: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          planModel: 'claude-haiku-4-5-20251001',
          promptSpecVersion: 'v2.2-gateway',
        },
      };
    },
    generate: async (
      _ctx: unknown,
      request: { pinned: Record<string, unknown> | null },
    ) => {
      pinnedSeen.push(request.pinned ?? {});
      if (opts?.failFirstRecipient && pinnedSeen.length === 1) {
        // Gateway failure isolation for recipient #1: outcome 'error', not a
        // throw — the batch maps it to status:'error' and keeps going.
        return {
          outcome: 'error',
          generationKey: 'individual:a',
          recipientKey: 'a',
          subject: '',
          body: '',
          manifest: {},
          sendable: false,
          error: 'GENERATION_FAILED',
          pinned: request.pinned ?? {},
        };
      }
      return {
        outcome: 'ready',
        generationKey: 'individual:x',
        recipientKey: 'x',
        subject: 's',
        body: 'b',
        manifest: {},
        sendable: true,
        pinned: request.pinned ?? {},
      };
    },
  };
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        user: { findFirst: async () => ({ firstName: 'Uma', lastName: 'Sender' }) },
        aiUsageEvent: {
          aggregate: async () => ({ _sum: { inputTokens: 0, outputTokens: 0 } }),
        },
      }),
  };
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.directory = { findContactsByEmails: async () => [] };
  patch.loadUserVoiceBlock = async () => null;
  patch.batchRecipientCorrespondence = async () => ({
    meetingsByEmail: new Map(),
    threadsByEmail: new Map(),
  });
  patch.outreachMemberPress = async () => new Map();
  patch.recordAiUsage = async () => {};
  return { service, pinnedSeen, resolveCalls: () => resolveCalls };
}

const RECIPIENTS = [
  { email: 'a@mail.house.gov', name: 'A' },
  { email: 'b@mail.house.gov', name: 'B' },
  { email: 'c@mail.house.gov', name: 'C' },
];

describe('generateBatchEmails — campaign-sticky provider (M2/W3.2)', () => {
  test('the identity is resolved ONCE and every recipient request carries the same pin', async () => {
    const { service, pinnedSeen, resolveCalls } = makeService();
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: RECIPIENTS,
    });
    expect(results).toHaveLength(3);
    expect(resolveCalls()).toBe(1);
    expect(pinnedSeen).toHaveLength(3);
    for (const pinned of pinnedSeen) {
      expect(pinned).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    }
  });

  test('a caller-supplied pinnedIdentity wins over the resolved one', async () => {
    const { service, pinnedSeen } = makeService();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENTS[0]!],
      pinnedIdentity: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        planModel: null,
        promptSpecVersion: 'v2.2-gateway',
      },
    });
    expect(pinnedSeen).toHaveLength(1);
    expect(pinnedSeen[0]).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' });
  });

  test('a first-recipient gateway failure stays pinned: later slots ready on the SAME identity, resolved once', async () => {
    const { service, pinnedSeen, resolveCalls } = makeService({ failFirstRecipient: true });
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: RECIPIENTS,
    });
    // #1 errored (status 'error'), #2/#3 still drafted — statuses split exactly.
    expect(results.map((r) => r.status)).toEqual(['error', 'ready', 'ready']);
    expect(results[0]!.error).toBe('GENERATION_FAILED');
    // The campaign identity was resolved ONCE — a failed slot never
    // re-resolves credentials.
    expect(resolveCalls()).toBe(1);
    // Every request (including the failed one) carried the SAME resolved pin.
    expect(pinnedSeen).toHaveLength(3);
    for (const pinned of pinnedSeen) {
      expect(pinned).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
    }
  });
});
