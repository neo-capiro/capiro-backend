// H2 — `GET …/meeting-preps/:prepId` had no route at all: the documented detail read
// 404'd while prep prose sat inside meeting detail and list payloads.
//
// Review finding 1: ownership alone is not current authorization. `ensureOwnMeeting`
// only proves tenant + meeting owner/connection, and `assertSavedMeetingPrepAccess`
// intentionally returns for a legacy prep without a briefing manifest. These tests
// therefore drive the REAL guard seams — `currentMeetingActor`, `ensureOwnMeeting`,
// `assertMeetingClient` and the shared `clientMemoryAllowed` wall query — through a
// transaction stub, instead of mocking the authorization away.
import { describe, expect, test, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  tenantSlug: 'acme',
  userId: '22222222-2222-2222-2222-222222222222',
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

const storedPrep = {
  id: 'prep-1',
  tenantId: ctx.tenantId,
  meetingId: 'meeting-1',
  // A prep written before the client stamp existed. The client now reads it from the
  // meeting payload; this read must return it under the parent client's admission,
  // not under ownership alone.
  clientId: null as string | null,
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

interface State {
  /** `null` means the caller has no ACTIVE membership in this tenant. */
  membership: { role: string } | null;
  /** The meeting row `ensureOwnMeeting` is allowed to find (owner + not deleted). */
  meeting: { id: string; clientId: string | null } | null;
  /** The client row, or null when the client is archived / out of tenant scope. */
  client: { id: string } | null;
  /** Result of the real `clientMemoryAllowed` wall query. */
  allowed: boolean;
  /** First (selected) prep read. */
  prep: { id: string; meetingId: string; generatedFrom: unknown } | null;
  /** Second (full row) prep read, after the awaited checks. */
  fullRow: Record<string, unknown> | null;
}

function harness(overrides: Partial<State> = {}) {
  const state: State = {
    membership: { role: 'standard_user' },
    meeting: { id: 'meeting-1', clientId: 'client-1' },
    client: { id: 'client-1' },
    allowed: true,
    prep: { id: 'prep-1', meetingId: 'meeting-1', generatedFrom: {} },
    fullRow: storedPrep,
    ...overrides,
  };
  const tenantMembershipFindFirst = jest.fn(async () => state.membership);
  const meetingFindFirst = jest.fn(async () => state.meeting);
  const clientFindFirst = jest.fn(async () => state.client);
  const queryRaw = jest.fn(async () => [{ allowed: state.allowed }]);
  const prepFindFirst = jest
    .fn<(...args: unknown[]) => Promise<unknown>>()
    .mockResolvedValueOnce(state.prep)
    .mockResolvedValueOnce(state.fullRow);
  const tx = {
    tenantMembership: { findFirst: tenantMembershipFindFirst },
    meeting: { findFirst: meetingFindFirst },
    client: { findFirst: clientFindFirst },
    meetingPrep: { findFirst: prepFindFirst },
    $queryRawUnsafe: queryRaw,
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service as unknown as Record<string, unknown>, {
    prisma: {
      withTenantUser: (
        _tenantId: string,
        _userId: string,
        fn: (tx: unknown) => unknown,
      ) => fn(tx),
      // The read must never fall back to the non-actor transaction: that is the
      // defect this correction removes.
      withTenant: () => {
        throw new Error(
          'readMeetingPrep must use the current-actor transaction',
        );
      },
    },
  });
  return {
    service,
    prepFindFirst,
    meetingFindFirst,
    clientFindFirst,
    tenantMembershipFindFirst,
    queryRaw,
  };
}

describe('EngagementService.readMeetingPrep — current actor and parent-client admission', () => {
  test('returns a legacy null-client prep for an active member under an admitted client', async () => {
    const h = harness();
    const prep = await h.service.readMeetingPrep(ctx, 'prep-1');
    expect(prep.clientId).toBeNull();
    expect(prep.agenda).toEqual(['Synthetic agenda']);
    expect(prep.talkingPoints).toEqual(['Synthetic point']);
    // Live membership was re-read, not taken from the cached request role.
    expect(h.tenantMembershipFindFirst).toHaveBeenCalledTimes(1);
    // The parent client was admitted through the real wall query, scoped to the caller.
    expect(h.queryRaw).toHaveBeenCalledTimes(1);
    expect(h.queryRaw.mock.calls[0]).toEqual([
      expect.stringContaining('client_memory_access'),
      ctx.tenantId,
      'client-1',
      ctx.userId,
    ]);
    // Tenant scoping on both prep reads, never only on the first.
    for (const call of h.prepFindFirst.mock.calls)
      expect(call[0]).toMatchObject({
        where: { id: 'prep-1', tenantId: ctx.tenantId },
      });
  });

  test('ordinary owner refused when the parent client wall excludes them', async () => {
    const h = harness({ allowed: false });
    await expect(
      h.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The body was never read: the wall is decided before the full-row read.
    expect(h.prepFindFirst).toHaveBeenCalledTimes(1);
  });

  test('refuses an archived parent client', async () => {
    const h = harness({ client: null });
    await expect(
      h.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prepFindFirst).toHaveBeenCalledTimes(1);
  });

  test('refuses a caller without an active membership, before any prep read', async () => {
    const h = harness({ membership: null });
    await expect(
      h.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prepFindFirst).not.toHaveBeenCalled();
    expect(h.clientFindFirst).not.toHaveBeenCalled();
  });

  test('tenant isolation: a prep that is not visible in this tenant is not found', async () => {
    const h = harness({ prep: null });
    await expect(
      h.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.meetingFindFirst).not.toHaveBeenCalled();
  });

  test('a meeting outside the caller ownership boundary is not found', async () => {
    const h = harness({ meeting: null });
    await expect(
      h.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  test('the returned row must still belong to the admitted parent and client', async () => {
    // The row that comes back after the awaited checks has moved to another client.
    const movedClient = harness({
      fullRow: { ...storedPrep, clientId: 'client-9' },
    });
    await expect(
      movedClient.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // ...or to another meeting entirely.
    const movedMeeting = harness({
      fullRow: { ...storedPrep, meetingId: 'meeting-9' },
    });
    await expect(
      movedMeeting.service.readMeetingPrep(ctx, 'prep-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('a prep stamped with the admitted parent client is returned, stamp preserved', async () => {
    const h = harness({ fullRow: { ...storedPrep, clientId: 'client-1' } });
    const prep = await h.service.readMeetingPrep(ctx, 'prep-1');
    expect(prep.clientId).toBe('client-1');
  });
});
