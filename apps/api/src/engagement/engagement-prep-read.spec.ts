// H2 — `GET …/meeting-preps/:prepId` had no route at all: the documented detail read
// 404'd while prep prose sat inside meeting detail and list payloads, so the editor
// had to scrape the meeting body. These tests pin the read to the same tenant scoping
// and the same ownership/access checks the update path uses.
import { describe, expect, test, jest } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  tenantSlug: 'acme',
  userId: '22222222-2222-2222-2222-222222222222',
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

type Row = Record<string, unknown> | null;
function makeService(rows: Row[], overrides: Record<string, unknown> = {}) {
  const findFirst = jest.fn<(...args: unknown[]) => Promise<Row>>();
  for (const row of rows) findFirst.mockResolvedValueOnce(row);
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service as unknown as Record<string, unknown>, {
    prisma: {
      withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
        fn({ meetingPrep: { findFirst } }),
    },
    ensureOwnMeeting: jest.fn(async () => undefined),
    ...overrides,
  });
  return { service, findFirst };
}

const stored = {
  id: 'prep-1',
  tenantId: ctx.tenantId,
  meetingId: 'meeting-1',
  // A legacy prep carries no client stamp. The read must return it as stored
  // instead of failing the row (B0/H2).
  clientId: null,
  status: 'approved',
  summary: 'Synthetic summary',
  agenda: ['Synthetic agenda'],
  talkingPoints: [{ text: 'Synthetic point', factIds: ['fact-1'] }],
  risks: [],
  followUps: [],
  emailEvidence: [],
  provider: 'anthropic',
  model: 'synthetic-model',
  generatedFrom: {},
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z'),
};

describe('EngagementService.readMeetingPrep', () => {
  test('returns a stored legacy prep verbatim, with list items projected to text', async () => {
    const { service, findFirst } = makeService([stored, stored]);
    const prep = await service.readMeetingPrep(ctx, 'prep-1');
    expect(prep.clientId).toBeNull();
    expect(prep.agenda).toEqual(['Synthetic agenda']);
    expect(prep.talkingPoints).toEqual(['Synthetic point']);
    expect(findFirst).toHaveBeenCalledTimes(2);
    // Tenant scoping is on both reads, never only on the first.
    for (const call of findFirst.mock.calls) {
      expect(call[0]).toMatchObject({
        where: { id: 'prep-1', tenantId: ctx.tenantId },
      });
    }
  });

  test('a prep outside the tenant is not found, and no ownership check runs', async () => {
    const ensureOwnMeeting = jest.fn(async () => undefined);
    const { service } = makeService([null], { ensureOwnMeeting });
    await expect(service.readMeetingPrep(ctx, 'prep-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(ensureOwnMeeting).not.toHaveBeenCalled();
  });

  test('the meeting ownership wall still applies to the read', async () => {
    const ensureOwnMeeting = jest.fn(async () => {
      throw new ForbiddenException('Meeting is outside the caller scope');
    });
    const { service, findFirst } = makeService([stored], { ensureOwnMeeting });
    await expect(service.readMeetingPrep(ctx, 'prep-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ensureOwnMeeting).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      'meeting-1',
    );
    // The body read never happens once the wall refuses.
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
