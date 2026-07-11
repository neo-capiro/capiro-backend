// generateBatchEmails group suppression (W0.3). A 'group' batch is ONE shared
// email whose single recipient stands in for the whole group, so per-MEMBER
// enrichment (that member's directory profile, press, meeting + email history)
// must NOT be hoisted into the prompt context — else the group draft tailors
// itself to member #1. buildOutreachPrompt only proves the greeting swap; this
// proves the SUPPRESSION happens upstream in the context assembly.
//
// Prototype-stub pattern (see engagement-audiences.spec / engagement-insights.spec):
// a real EngagementService prototype over stubbed deps, spying on the AI
// draft-generation boundary to capture the per-recipient context.

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

// One directory member match so recipientProfile + bioguide (→ press) resolve.
const directoryMatch = {
  attendeeEmail: 'dana@mail.house.gov',
  matchKind: 'member' as const,
  directoryContactName: 'Dana Reed',
  member: {
    bioguideId: 'D001',
    memberName: 'Dana Reed',
    title: 'Rep. Dana Reed',
    state: 'CA',
    district: '12',
    partyName: 'Democratic',
    committees: ['Armed Services'],
    leadershipPositions: [],
  },
};

function serviceCapturingContext(): {
  service: EngagementService;
  contexts: Array<Record<string, unknown>>;
} {
  const contexts: Array<Record<string, unknown>> = [];
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.ai = {
    generateOutreachDraft: async (input: { context: Record<string, unknown> }) => {
      contexts.push(input.context);
      return { subject: 's', body: 'b', provider: 'anthropic', model: 'm', raw: {} };
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
  patch.directory = { findContactsByEmails: async () => [directoryMatch] };
  // Per-member enrichment sources — all populated so an INDIVIDUAL draft has them
  // and we can prove a GROUP draft does not.
  patch.loadUserVoiceBlock = async () => null;
  patch.batchRecipientCorrespondence = async () => ({
    meetingsByEmail: new Map([['dana@mail.house.gov', [{ subject: 'Prior meeting' }]]]),
    threadsByEmail: new Map([['dana@mail.house.gov', [{ subject: 'Prior thread' }]]]),
  });
  patch.outreachMemberPress = async () => new Map([['D001', [{ title: 'Recent press' }]]]);
  patch.recordAiUsage = async () => {};
  return { service, contexts };
}

const RECIPIENT = { email: 'dana@mail.house.gov', directoryContactId: 'dc-1', name: 'Dana Reed' };
const PER_MEMBER_KEYS = [
  'recipientProfile',
  'recentNews',
  'meetingHistory',
  'emailHistory',
] as const;

describe('generateBatchEmails — group per-member enrichment suppression (W0.3)', () => {
  test('an INDIVIDUAL draft receives the per-member enrichment', async () => {
    const { service, contexts } = serviceCapturingContext();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT],
    });
    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    for (const key of PER_MEMBER_KEYS) {
      expect(context[key]).toBeDefined();
    }
    expect(typeof context.recipientProfile).toBe('string');
  });

  test('a GROUP draft suppresses every per-member field but keeps shared context', async () => {
    const { service, contexts } = serviceCapturingContext();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT],
      audienceKind: 'group',
    });
    expect(contexts).toHaveLength(1);
    const context = contexts[0]!;
    for (const key of PER_MEMBER_KEYS) {
      expect(context[key]).toBeUndefined();
    }
    // Shared, non-member-specific context is unaffected.
    expect(context.tone).toBe('professional');
    expect(context.senderName).toBe('Uma Sender');
  });
});
