// generateBatchEmails per-recipient error status (W0.2). A recipient whose draft
// generation throws inside an otherwise-successful batch must come back tagged
// `status:'error'` (with empty subject/body), NOT a blank `status:'ready'` draft
// that the wizard would show as a false "ready" checkmark and silently drop at
// send. This locks the additive status contract the frontend gates sendability on.
//
// Prototype-stub pattern (mirrors engagement-batch-group.spec.ts): a real
// EngagementService prototype over stubbed deps; ai.generateOutreachDraft throws
// for exactly one recipient so we can assert the split.

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

/** A service whose AI draft call throws for RECIPIENT_FAIL's email, succeeds otherwise. */
function serviceWithOneFailingRecipient(): EngagementService {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 1: generateBatchEmails branches on this.gateway.enabled before doing
  // anything else. These specs build the service with Object.create (no
  // constructor), so the injected dependency has to be supplied here. OFF selects
  // the legacy path, which is what these specs exercise.
  patch.gateway = { enabled: false };
  // The failure path logs a warning before returning the error result — stub the
  // logger so the catch block doesn't itself throw on `this.logger` being unset.
  patch.logger = { warn: () => {} };
  patch.ai = {
    resolveOutreachCredentials: async () => [
      {
        provider: 'anthropic',
        apiKey: 'k',
        model: 'm',
        usedTenantKey: false,
        modelOverridden: false,
      },
    ],
    generateOutreachDraft: async (input: { recipients: Array<Record<string, unknown>> }) => {
      const email = input.recipients[0]?.email?.toString() ?? '';
      if (email === RECIPIENT_FAIL.email) {
        throw new Error('simulated provider failure for this recipient');
      }
      return {
        subject: 'Real subject',
        body: 'Real body',
        provider: 'anthropic',
        model: 'm',
        raw: {},
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
      }),
  };
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

    const ok = results.find((r) => r.recipientId === RECIPIENT_OK.email)!;
    expect(ok.status).toBe('ready');
    expect(ok.subject).toBe('Real subject');
    expect(ok.body).toBe('Real body');

    const failed = results.find((r) => r.recipientId === RECIPIENT_FAIL.email)!;
    expect(failed.status).toBe('error');
    expect(failed.subject).toBe('');
    expect(failed.body).toBe('');
    expect(failed.error).toContain('simulated provider failure');
  });

  test('every result carries an explicit status — no branch can omit it', async () => {
    const service = serviceWithOneFailingRecipient();
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT_OK, RECIPIENT_FAIL],
    });
    expect(results.every((r) => r.status === 'ready' || r.status === 'error')).toBe(true);
  });
});
