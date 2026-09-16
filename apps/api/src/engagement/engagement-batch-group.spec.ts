// generateBatchEmails group suppression (W0.3). A 'group' batch is ONE shared
// email whose single recipient stands in for the whole group, so per-MEMBER
// enrichment channels (directory profile, press, hearings, prior outreach)
// must NOT be offered to the gateway — else the group draft tailors itself to
// member #1. The Phase 26 cutover moved batch generation behind the governed
// gateway unconditionally, so this proves the SUPPRESSION at the boundary the
// production path actually calls: gateway.generate's enrichment channels.
//
// Prototype-stub pattern (see engagement-audiences.spec / engagement-insights.spec):
// a real EngagementService prototype over stubbed deps, spying on the
// GenerationGatewayService.generate boundary.

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

// One directory member match so the profile + bioguide (→ press) channels
// would resolve if (and only if) they were offered for this recipient.
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

interface CapturedGenerate {
  enrichmentChannels: string[];
  audienceKind?: string;
  tone?: string;
  request: Record<string, unknown>;
  enrichment: {
    channels: Array<{ sourceType: string; load: () => Promise<string | null> }>;
  };
}

function serviceCapturingEnrichment(): {
  service: EngagementService;
  captured: CapturedGenerate[];
} {
  const captured: CapturedGenerate[] = [];
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // The Phase 26 cutover routes batch generation through the governed gateway
  // unconditionally; stub the gateway's two entry points the batch path uses.
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
      request: Record<string, unknown>,
      enrichment: { channels: Array<{ sourceType: string; load: () => Promise<string | null> }> },
    ) => {
      captured.push({
        enrichmentChannels: enrichment.channels.map((c) => c.sourceType),
        audienceKind: request.audienceKind as string | undefined,
        tone: request.tone as string | undefined,
        request,
        enrichment,
      });
      return {
        outcome: 'ready',
        generationKey: 'individual:dana',
        recipientKey: 'dana',
        subject: 's',
        body: 'b',
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
  patch.directory = { findContactsByEmails: async () => [directoryMatch] };
  // Per-member enrichment sources — all populated so an INDIVIDUAL draft has
  // them and we can prove a GROUP draft does not ask for them.
  patch.loadUserVoiceBlock = async () => null;
  patch.batchRecipientCorrespondence = async () => ({
    meetingsByEmail: new Map([['dana@mail.house.gov', [{ subject: 'Prior meeting' }]]]),
    threadsByEmail: new Map([['dana@mail.house.gov', [{ subject: 'Prior thread' }]]]),
  });
  patch.outreachMemberPress = async () => new Map([['D001', [{ title: 'Recent press' }]]]);
  patch.outreachUpcomingHearings = async () => [
    { committee: 'Armed Services', date: '2026-09-20', title: 'Hearing' },
  ];
  patch.outreachRelevantVotesByBioguide = async () => new Map();
  patch.outreachPriorContactByEmail = async () => new Map();
  patch.recordAiUsage = async () => {};
  return { service, captured };
}

const RECIPIENT = { email: 'dana@mail.house.gov', directoryContactId: 'dc-1', name: 'Dana Reed' };
// Channels a per-member draft may see; a GROUP draft must not.
const PER_MEMBER_CHANNELS = ['directory', 'press', 'upcomingHearings', 'priorOutreach'] as const;

describe('generateBatchEmails — group per-member enrichment suppression (W0.3)', () => {
  test('an INDIVIDUAL draft receives the per-member enrichment channels', async () => {
    const { service, captured } = serviceCapturingEnrichment();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT],
    });
    expect(captured).toHaveLength(1);
    const channels = captured[0]!.enrichmentChannels;
    for (const channel of PER_MEMBER_CHANNELS) {
      expect(channels).toContain(channel);
    }
    expect(captured[0]!.audienceKind).toBe('individual');
  });

  test('a GROUP draft suppresses every per-member channel but keeps shared context', async () => {
    const { service, captured } = serviceCapturingEnrichment();
    await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: [RECIPIENT],
      audienceKind: 'group',
      // Shared (campaign-level) context the group draft must still see.
      additionalContext: 'Shared coalition ask: fund directed-energy in FY27 NDAA.',
    });
    expect(captured).toHaveLength(1);
    const channels = captured[0]!.enrichmentChannels;
    for (const channel of PER_MEMBER_CHANNELS) {
      expect(channels).not.toContain(channel);
    }
    expect(captured[0]!.audienceKind).toBe('group');
    // Shared, non-member-specific context is unaffected by group suppression.
    expect(captured[0]!.tone).toBe('professional');
    // The explicit additionalContext the user typed survives as a channel…
    const additional = captured[0]!.enrichment.channels.find(
      (c) => c.sourceType === 'additionalContext',
    );
    expect(additional).toBeDefined();
    // …and its thunk still resolves the exact text (invoke it, don't trust the label).
    expect(await additional!.load()).toBe('Shared coalition ask: fund directed-energy in FY27 NDAA.');
  });
});
