// Campaign-sticky provider (M2 / W3.2). A batch resolves the credential order
// ONCE and pins the provider that drafts recipient #1 across the whole campaign,
// so a per-recipient fallback can never split one send between two provider
// "voices". This proves recipient #1 sees the full ordered list (so it can still
// fall back if the preferred provider is down), and recipients 2..N see ONLY the
// pinned provider's credential.
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

const ANTHROPIC = {
  provider: 'anthropic' as const,
  apiKey: 'a',
  model: 'claude-sonnet-4-6',
  usedTenantKey: false,
  modelOverridden: false,
};
const OPENAI = {
  provider: 'openai' as const,
  apiKey: 'o',
  model: 'gpt-4.1-mini',
  usedTenantKey: false,
  modelOverridden: false,
};

/** Service whose AI stub records the provider list handed to each draft call and
 *  "drafts" with the first credential offered (or throws for a chosen recipient). */
function makeService(opts?: { failFirst?: boolean }): {
  service: EngagementService;
  credCalls: string[][];
} {
  const credCalls: string[][] = [];
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 1: generateBatchEmails branches on this.gateway.enabled before doing
  // anything else. These specs build the service with Object.create (no
  // constructor), so the injected dependency has to be supplied here. OFF selects
  // the legacy path, which is what these specs exercise.
  patch.gateway = { enabled: false };
  patch.logger = { warn: () => {} };
  patch.ai = {
    // Anthropic-first ordered list (as D2's preference would produce).
    resolveOutreachCredentials: async () => [ANTHROPIC, OPENAI],
    generateOutreachDraft: async (
      _input: unknown,
      _ctx: unknown,
      o?: { creds?: Array<{ provider: string }> },
    ) => {
      const provided = (o?.creds ?? []).map((c) => c.provider);
      credCalls.push(provided);
      if (opts?.failFirst && credCalls.length === 1) {
        throw new Error('simulated failure on recipient #1');
      }
      // Draft "uses" the first credential in the list it was handed.
      return { subject: 's', body: 'b', provider: provided[0] ?? 'anthropic', model: 'm', raw: {} };
    },
  };
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({ user: { findFirst: async () => ({ firstName: 'Uma', lastName: 'Sender' }) } }),
  };
  patch.directory = { findContactsByEmails: async () => [] };
  patch.loadUserVoiceBlock = async () => null;
  patch.batchRecipientCorrespondence = async () => ({
    meetingsByEmail: new Map(),
    threadsByEmail: new Map(),
  });
  patch.outreachMemberPress = async () => new Map();
  patch.recordAiUsage = async () => {};
  return { service, credCalls };
}

const RECIPIENTS = [
  { email: 'a@mail.house.gov', name: 'A' },
  { email: 'b@mail.house.gov', name: 'B' },
  { email: 'c@mail.house.gov', name: 'C' },
];

describe('generateBatchEmails — campaign-sticky provider (M2/W3.2)', () => {
  test('recipient #1 sees the full ordered list; the rest are pinned to the winner', async () => {
    const { service, credCalls } = makeService();
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: RECIPIENTS,
    });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'ready')).toBe(true);
    // #1 gets both providers (can still fall back if the preferred is down)…
    expect(credCalls[0]).toEqual(['anthropic', 'openai']);
    // …#2 and #3 are pinned to the provider that drafted #1 (anthropic).
    expect(credCalls[1]).toEqual(['anthropic']);
    expect(credCalls[2]).toEqual(['anthropic']);
  });

  test('if recipient #1 fails outright, the rest fall back across the full list', async () => {
    const { service, credCalls } = makeService({ failFirst: true });
    const { results } = await service.generateBatchEmails(ctx, {
      templateId: 'system-outreach-message',
      recipients: RECIPIENTS,
    });
    // #1 errored (nothing to pin) → #2/#3 still get the full ordered list.
    expect(results[0]!.status).toBe('error');
    expect(credCalls[0]).toEqual(['anthropic', 'openai']);
    expect(credCalls[1]).toEqual(['anthropic', 'openai']);
    expect(credCalls[2]).toEqual(['anthropic', 'openai']);
  });
});
