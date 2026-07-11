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
