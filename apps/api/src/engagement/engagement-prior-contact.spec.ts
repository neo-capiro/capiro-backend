// getRecipientPriorContact (W5.2) — the public read wrapper feeding the wizard's
// "last contacted" badge. Delegates to the same private 90-day sent-OutreachRecord
// query the generator uses, so the badge and the prompt line can't drift. Verifies
// the filters (status/window/deletedAt/clientId) hold and that absent = no row
// (never fabricated). Prototype-stub pattern.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

/** Service whose outreachRecord.findMany returns canned rows + captures the where. */
function serviceWithRecords(
  rows: Array<{ subject: string | null; sentAt: Date | null; recipients: unknown }>,
): { service: EngagementService; lastWhere: () => Record<string, unknown> | null } {
  let lastWhere: Record<string, unknown> | null = null;
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 1: generateBatchEmails branches on this.gateway.enabled before doing
  // anything else. These specs build the service with Object.create (no
  // constructor), so the injected dependency has to be supplied here. OFF selects
  // the legacy path, which is what these specs exercise.
  patch.gateway = { enabled: false };
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        outreachRecord: {
          findMany: async ({ where }: { where: Record<string, unknown> }) => {
            lastWhere = where;
            return rows;
          },
        },
      }),
  };
  return { service, lastWhere: () => lastWhere };
}

const sent = (email: string, daysAgo: number, subject: string | null = 'Prior ask') => ({
  subject,
  sentAt: new Date(Date.now() - daysAgo * 864e5),
  recipients: [{ email }],
});

describe('getRecipientPriorContact (W5.2)', () => {
  test('returns {email, sentAt ISO, subject} for a recipient with a recent sent record', async () => {
    const { service } = serviceWithRecords([sent('dana@mail.house.gov', 12)]);
    const out = await service.getRecipientPriorContact(ctx, {
      emails: ['Dana@mail.house.gov'],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.email).toBe('dana@mail.house.gov'); // lowercased match
    expect(typeof out[0]!.sentAt).toBe('string');
    expect(out[0]!.subject).toBe('Prior ask');
  });

  test('omits (does not fabricate) a recipient with no matching sent record', async () => {
    const { service } = serviceWithRecords([sent('someone-else@mail.house.gov', 5)]);
    const out = await service.getRecipientPriorContact(ctx, { emails: ['nobody@x.com'] });
    expect(out).toEqual([]);
  });

  test('query filters on status=sent, deletedAt=null, the 90d window, and clientId when given', async () => {
    const { service, lastWhere } = serviceWithRecords([]);
    await service.getRecipientPriorContact(ctx, { clientId: 'client-9', emails: ['a@x.com'] });
    const where = lastWhere()!;
    expect(where.status).toBe('sent');
    expect(where.deletedAt).toBeNull();
    expect(where.clientId).toBe('client-9');
    expect((where.sentAt as { gte: Date }).gte).toBeInstanceOf(Date);
  });

  test('no clientId → no clientId filter (tenant-wide lookup)', async () => {
    const { service, lastWhere } = serviceWithRecords([]);
    await service.getRecipientPriorContact(ctx, { emails: ['a@x.com'] });
    expect('clientId' in (lastWhere() ?? {})).toBe(false);
  });

  test('empty email list short-circuits (no query, empty result)', async () => {
    const { service, lastWhere } = serviceWithRecords([sent('a@x.com', 1)]);
    const out = await service.getRecipientPriorContact(ctx, { emails: [] });
    expect(out).toEqual([]);
    expect(lastWhere()).toBeNull(); // findMany never called
  });
});

/**
 * Cross-client confidentiality.
 *
 * The badge above answers "has my firm emailed this person recently" inside the
 * user's own workspace, so it may legitimately run tenant-wide. The GENERATOR must
 * not: it renders the answer as `Your firm last emailed this recipient on <date> re:
 * "<subject>"` straight into the prompt, so a tenant-wide match put one client's
 * campaign subject line into another client's draft. For a lobbying firm whose
 * congressional contacts are shared across the whole portfolio that is routine, not
 * exotic — it is how an Omega campaign started talking about Snowbird.
 *
 * The two callers are therefore allowed to disagree for a no-client campaign, and
 * these tests pin that divergence so a future refactor cannot quietly re-widen it.
 */
describe('the generator’s prior-outreach lookup is client-scoped or empty', () => {
  /** The private batch query the generator calls (the badge goes through the wrapper). */
  const generatorLookup = (service: EngagementService) =>
    (
      service as unknown as {
        outreachPriorContactByEmail: (
          c: TenantContext,
          clientId: string | null,
          emails: string[],
          opts?: { requireClient?: boolean },
        ) => Promise<Map<string, { sentAt: Date; subject: string | null }>>;
      }
    ).outreachPriorContactByEmail.bind(service);

  test('with a client, it filters on that client', async () => {
    const { service, lastWhere } = serviceWithRecords([]);
    await generatorLookup(service)(ctx, 'client-9', ['a@x.com']);
    expect(lastWhere()!.clientId).toBe('client-9');
  });

  test('with NO client it returns empty and never queries at all', async () => {
    // Default-deny. Widening to the tenant is the leak, so the absence of a client
    // must produce nothing rather than everything.
    const { service, lastWhere } = serviceWithRecords([sent('dana@mail.house.gov', 3, 'Snowbird — FY27 ask')]);
    const out = await generatorLookup(service)(ctx, null, ['dana@mail.house.gov']);
    expect(out.size).toBe(0);
    expect(lastWhere()).toBeNull();
  });

  test("another client's subject line cannot reach a no-client campaign's prompt", async () => {
    const { service } = serviceWithRecords([sent('dana@mail.house.gov', 3, 'Snowbird — FY27 ask')]);
    const out = await generatorLookup(service)(ctx, null, ['dana@mail.house.gov']);
    expect(JSON.stringify([...out.values()])).not.toMatch(/Snowbird/);
  });

  test('the badge wrapper keeps its tenant-wide latitude via requireClient:false', async () => {
    const { service } = serviceWithRecords([sent('dana@mail.house.gov', 3)]);
    const out = await generatorLookup(service)(ctx, null, ['dana@mail.house.gov'], {
      requireClient: false,
    });
    expect(out.size).toBe(1);
  });
});
