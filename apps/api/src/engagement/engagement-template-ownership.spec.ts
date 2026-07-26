// Engagement Phase 0 (plan §3.h1) — custom AI templates are OWNER-private.
//
// list/update/delete were already owner-scoped, but previewAiTemplate() and the
// custom-template lookup inside generateBatchEmails() queried by tenant + id
// only. Any colleague's private drafting prompt could therefore be read (and
// billed against) by guessing or observing its id. Both reads now require
// `userId`, and a foreign id must return the SAME not-found as a nonexistent one
// so ownership is never disclosed.

import { describe, expect, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const userA: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as TenantContext;
const userB: TenantContext = { ...userA, userId: 'user-b' } as TenantContext;

/** The template row belongs to user-a. */
const TEMPLATE = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 't1',
  userId: 'user-a',
  name: "User A's private prompt",
  prompt: 'Write like a defense-appropriations specialist.',
};

interface Harness {
  service: EngagementService;
  /** Every `where` the template lookup used — the assertion target. */
  whereCalls: Array<Record<string, unknown>>;
}

function makeService(): Harness {
  const whereCalls: Array<Record<string, unknown>> = [];
  const tx = {
    outreachAiTemplate: {
      // Faithful to Prisma: a `where` naming a different userId matches nothing.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        whereCalls.push(where);
        if (where.id !== TEMPLATE.id) return null;
        if (where.tenantId !== TEMPLATE.tenantId) return null;
        if ('userId' in where && where.userId !== TEMPLATE.userId) return null;
        return TEMPLATE;
      },
      update: async () => ({}),
    },
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.prisma = { withTenant: (_t: string, fn: (t: unknown) => unknown) => fn(tx) };
  patch.ai = {
    generateOutreachDraft: async () => ({
      subject: 'S',
      body: 'B',
      contextNote: '',
      provider: 'anthropic',
      model: 'claude',
      promptSpecVersion: 'v2.1',
      raw: {},
    }),
  };
  patch.recordAiUsage = async () => {};
  return { service, whereCalls };
}

describe('previewAiTemplate ownership (§3.h1)', () => {
  test('the OWNER can preview their own custom template', async () => {
    const h = makeService();
    const out = await h.service.previewAiTemplate(userA, TEMPLATE.id);
    expect(out.templateName).toBe(TEMPLATE.name);
    // The lookup was owner-scoped, not merely tenant-scoped.
    expect(h.whereCalls[0]).toMatchObject({ userId: 'user-a', tenantId: 't1' });
  });

  test("another user CANNOT preview it, and gets the generic not-found", async () => {
    const h = makeService();
    let caught: unknown;
    try {
      await h.service.previewAiTemplate(userB, TEMPLATE.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    // Identical message to a nonexistent template: existence is not disclosed.
    expect((caught as NotFoundException).message).toBe('AI template not found');
  });

  test('a nonexistent id gives the SAME response as a foreign id', async () => {
    const h = makeService();
    const foreign = await h.service
      .previewAiTemplate(userB, TEMPLATE.id)
      .catch((e: NotFoundException) => e.message);
    const missing = await h.service
      .previewAiTemplate(userA, '22222222-2222-4222-8222-222222222222')
      .catch((e: NotFoundException) => e.message);
    expect(foreign).toBe(missing);
  });

  test('every template lookup carries a userId predicate (no tenant-wide read remains)', async () => {
    const h = makeService();
    await h.service.previewAiTemplate(userA, TEMPLATE.id).catch(() => undefined);
    await h.service.previewAiTemplate(userB, TEMPLATE.id).catch(() => undefined);
    expect(h.whereCalls.length).toBeGreaterThan(0);
    for (const where of h.whereCalls) expect(where).toHaveProperty('userId');
  });
});

describe('generateBatchEmails custom-template ownership (§3.h1)', () => {
  /**
   * Drive ONLY the template-resolution prologue: the budget gate passes, then the
   * lookup runs. User B must be refused before any AI call is made — the whole
   * point is that a foreign prompt is never spent against.
   */
  function makeGenerateHarness() {
    const h = makeService();
    const patch = h.service as unknown as Record<string, unknown>;
    patch.outreachBudgetStatus = async () => ({
      hardStop: false,
      softWarn: false,
      ratio: 0,
    });
    patch.versionedOutreach = false;
    let aiCalls = 0;
    patch.ai = {
      resolveOutreachCredentials: async () => [{ provider: 'anthropic', model: 'claude' }],
      generateOutreachDraft: async () => {
        aiCalls++;
        return {
          subject: 'S',
          body: 'B',
          contextNote: '',
          provider: 'anthropic',
          model: 'claude',
          promptSpecVersion: 'v2.1',
          raw: {},
        };
      },
    };
    return { ...h, aiCalls: () => aiCalls };
  }

  test("user B cannot generate with user A's custom template, and no AI call is spent", async () => {
    const h = makeGenerateHarness();
    await expect(
      h.service.generateBatchEmails(userB, {
        templateId: TEMPLATE.id,
        recipients: [{ email: 'x@y.com' }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.aiCalls()).toBe(0);
    expect(h.whereCalls[0]).toMatchObject({ userId: 'user-b' });
  });
});
