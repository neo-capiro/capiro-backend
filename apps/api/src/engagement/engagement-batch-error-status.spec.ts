// generateBatchEmails per-recipient error status (W0.2). A recipient whose
// generation fails inside an otherwise-successful batch must come back tagged
// `status:'error'` (with empty subject/body), NOT a blank `status:'ready'` draft
// that the wizard would show as a false "ready" checkmark and silently drop at
// send. This locks the additive status contract the frontend gates sendability
// on.
//
// The Phase 26 cutover moved per-recipient failure isolation INTO
// GenerationGatewayService (a drafting failure returns outcome:'error' with
// error GENERATION_FAILED rather than throwing), so the batch-level contract
// proven here is: a gateway 'error' result maps to status:'error' with the
// error code, while the successful recipients stay 'ready'.
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

const RECIPIENT_OK = { email: 'ok@mail.house.gov', name: 'Okay Recipient' };
const RECIPIENT_FAIL = { email: 'fail@mail.house.gov', name: 'Fail Recipient' };

/** A gateway whose generate() fails for RECIPIENT_FAIL's email, succeeds otherwise. */
function serviceWithOneFailingRecipient(): EngagementService {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 26 cutover: batch generation runs through the governed gateway
  // unconditionally; stub its two entry points the batch path uses.
  patch.gateway = {
    resolvePinnedIdentity: async () => ({
      creds: [{ provider: 'anthropic', apiKey: 'test-key', model: 'm' }],
      pinned: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        planModel: 'claude-haiku-4-5-20251001',
        promptSpecVersion: 'v2.2-gateway',
      },
    }),
    generate: async (
      _ctx: unknown,
      request: { recipient: { email: string | null } },
    ) => {
      if (request.recipient.email === RECIPIENT_FAIL.email) {
        return {
          outcome: 'error',
          generationKey: 'individual:fail',
          recipientKey: 'fail',
          subject: '',
          body: '',
          manifest: {},
          sendable: false,
          error: 'GENERATION_FAILED',
          pinned: { provider: 'anthropic', model: 'm', planModel: null, promptSpecVersion: 'v2.2-gateway' },
        };
      }
      return {
        outcome: 'ready',
        generationKey: 'individual:ok',
        recipientKey: 'ok',
        subject: 'Real subject',
        body: 'Real body',
        manifest: {},
        sendable: true,
        pinned: { provider: 'anthropic', model: 'm', planModel: null, promptSpecVersion: 'v2.2-gateway' },
      };
    },
  };
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({
        user: {
          findFirst: async () => ({
            firstName: 'Uma',
            lastName: 'Sender',
            title: 'Director',
            email: 'uma@firm.com',
          }),
        },
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
  return service;
}

describe('generateBatchEmails — per-recipient error status (W0.2)', () => {
  test('a same-batch generation failure is tagged status:error with empty content + the error', async () => {
    const service = serviceWithOneFailingRecipient();
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_OK, RECIPIENT_FAIL],
    });
    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.recipientId === 'ok@mail.house.gov')!;
    const failed = results.find((r) => r.recipientId === 'fail@mail.house.gov')!;
    expect(ok.status).toBe('ready');
    expect(ok.subject).toBe('Real subject');
    expect(ok.body).toBe('Real body');
    // The failed slot is tagged, empty, and carries the machine error code.
    expect(failed.status).toBe('error');
    expect(failed.subject).toBe('');
    expect(failed.body).toBe('');
    expect(failed.error).toBe('GENERATION_FAILED');
  });

  test('every result carries an explicit status — no branch can omit it', async () => {
    const service = serviceWithOneFailingRecipient();
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_OK, RECIPIENT_FAIL],
    });
    // Every slot is explicitly 'ready' or 'error' — the wizard can never see a
    // blank status it would have to guess.
    expect(results.every((r) => r.status === 'ready' || r.status === 'error')).toBe(true);
  });
});
