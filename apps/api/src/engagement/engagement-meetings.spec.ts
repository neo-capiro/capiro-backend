// Meetings v2 (Phase 1) service logic: share/unshare stamping, the Meeting
// Library where-clause + pagination envelope, the client "shared from meetings"
// feed (tenant-scoped, NOT owner-scoped), and the decorated response fields
// (contributors / notesApproved / meri / sharedBy). Uses the same minimal-harness
// pattern as engagement-audiences.spec.ts (real prototype over a stub prisma) so
// the heavy constructor graph isn't wired.

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

function serviceWith(tx: Record<string, unknown>): EngagementService {
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(tx),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  (service as unknown as { prisma: unknown }).prisma = prisma;
  return service;
}

// A meeting row shaped like meetingInclude() output, enough for decorateMeetings.
function meetingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    createdByUserId: 'user-1',
    sharedByUserId: null,
    clientId: 'c1',
    visibility: 'private',
    notes: [],
    debriefs: [],
    preps: [],
    // Phase 2 §d — filterToSharedArtifacts (run on every row inside
    // listSharedMeetingsForClient) narrows this down to sharedAt != null.
    attachments: [],
    ...overrides,
  };
}

const decorateStubs = {
  user: {
    findMany: async () => [
      { id: 'user-1', firstName: 'Neo', lastName: 'Martinez', email: 'neo@capiro.ai' },
    ],
  },
  meetingBotSession: { findMany: async () => [] as Array<{ meetingId: string; status: string }> },
};

// tenant.findFirst stub for the meetingsCrossUser flag read (Phase 2 grouping).
const tenantFlag = (crossUser: boolean) => ({
  tenant: {
    findFirst: async () => ({
      settings: crossUser ? { clioFeatureFlags: { 'meetingsCrossUser.enabled': true } } : {},
    }),
  },
});

describe('shareMeeting', () => {
  test('refuses to share a meeting with no associated client', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1', clientId: null, visibility: 'private' }) },
    });
    await expect(service.shareMeeting(ctx, 'm1')).rejects.toThrow(/associated with a client/i);
  });

  test('throws when the meeting is not found / not owned', async () => {
    const service = serviceWith({ meeting: { findFirst: async () => null } });
    await expect(service.shareMeeting(ctx, 'm1')).rejects.toThrow('Meeting not found');
  });

  test('first share stamps sharedAt/sharedByUserId and returns the decorated record', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: {
        findFirst: async () => ({ id: 'm1', clientId: 'c1', visibility: 'private' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return meetingRow({
            visibility: 'shared',
            sharedByUserId: 'user-1',
            // Phase 2 §d — notesApproved now requires status: 'approved';
            // existence alone no longer counts (that was the whole point).
            notes: [{ id: 'n1', status: 'approved' }],
            debriefs: [{ status: 'approved' }],
            preps: [{ status: 'approved' }],
          });
        },
      },
      ...decorateStubs,
      meetingBotSession: { findMany: async () => [{ meetingId: 'm1', status: 'recording' }] },
    });

    const result = (await service.shareMeeting(ctx, 'm1')) as Record<string, unknown>;

    expect(updateArgs!.data.visibility).toBe('shared');
    expect(updateArgs!.data.sharedByUserId).toBe('user-1');
    expect(updateArgs!.data.sharedAt).toBeInstanceOf(Date);
    // Decorated response fields (§6).
    expect(result.notesApproved).toBe(true);
    expect(result.meri).toBe('attending');
    expect(result.contributors).toEqual([
      { userId: 'user-1', name: 'Neo Martinez', artifacts: ['prep', 'notes', 'debrief'] },
    ]);
    expect(result.sharedBy).toEqual({ userId: 'user-1', name: 'Neo Martinez' });
  });

  test('re-share preserves the FIRST sharer (does not overwrite the stamp)', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: {
        findFirst: async () => ({ id: 'm1', clientId: 'c1', visibility: 'shared' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return meetingRow({ visibility: 'shared', sharedByUserId: 'someone-else' });
        },
      },
      ...decorateStubs,
    });

    await service.shareMeeting(ctx, 'm1');

    expect(updateArgs!.data.visibility).toBe('shared');
    expect(updateArgs!.data).not.toHaveProperty('sharedByUserId');
    expect(updateArgs!.data).not.toHaveProperty('sharedAt');
  });
});

describe('unshareMeeting', () => {
  test('returns the record to private and clears the sharer stamp', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: {
        findFirst: async () => ({ id: 'm1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return meetingRow({ visibility: 'private' });
        },
      },
      ...decorateStubs,
    });

    await service.unshareMeeting(ctx, 'm1');

    expect(updateArgs!.data).toMatchObject({
      visibility: 'private',
      sharedAt: null,
      sharedByUserId: null,
    });
  });
});

describe('listMeetingLibrary', () => {
  test('builds the owner-scoped + approved-artifact where and paginates', async () => {
    let findArgs: Record<string, unknown> | undefined;
    let countArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      meeting: {
        count: async (args: Record<string, unknown>) => {
          countArgs = args;
          return 0;
        },
        findMany: async (args: Record<string, unknown>) => {
          findArgs = args;
          return [];
        },
      },
    });

    const res = await service.listMeetingLibrary(ctx, {
      clientId: 'c1',
      artifactType: 'debrief',
      visibility: 'shared',
      from: '2026-01-01',
      to: '2026-02-01',
      page: 2,
      limit: 10,
    });

    expect(res).toEqual({ data: [], total: 0, page: 2, limit: 10 });
    const where = findArgs!.where as Record<string, unknown>;
    expect(where.tenantId).toBe('tenant-1');
    // ownMeetingWhere — owner-scoped (this is a personal archive).
    expect(where.OR).toEqual([
      { createdByUserId: 'user-1' },
      { connection: { createdByUserId: 'user-1' } },
    ]);
    expect(where.clientId).toBe('c1');
    expect(where.visibility).toBe('shared');
    expect((where.startsAt as { gte: Date; lt: Date }).gte).toBeInstanceOf(Date);
    expect((where.startsAt as { gte: Date; lt: Date }).lt).toBeInstanceOf(Date);
    expect(where.AND).toEqual([{ debriefs: { some: { status: 'approved' } } }]);
    expect(findArgs!.skip).toBe(10);
    expect(findArgs!.take).toBe(10);
    expect(findArgs!.orderBy).toEqual({ startsAt: 'desc' });
    // count runs on the same where.
    expect((countArgs!.where as Record<string, unknown>).AND).toEqual(where.AND);
  });

  test('defaults page/limit and matches ANY approved artifact when no type given', async () => {
    let findArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      meeting: {
        count: async () => 0,
        findMany: async (args: Record<string, unknown>) => {
          findArgs = args;
          return [];
        },
      },
    });

    await service.listMeetingLibrary(ctx, {});

    const where = findArgs!.where as Record<string, unknown>;
    expect(where).not.toHaveProperty('clientId');
    expect(where).not.toHaveProperty('visibility');
    expect(where).not.toHaveProperty('startsAt');
    expect(where.AND).toEqual([
      {
        OR: [
          { preps: { some: { status: 'approved' } } },
          { debriefs: { some: { status: 'approved' } } },
          // Phase 2 §d — note existence no longer means approved.
          { notes: { some: { status: 'approved' } } },
        ],
      },
    ]);
    expect(findArgs!.skip).toBe(0);
    expect(findArgs!.take).toBe(50);
  });
});

describe('listSharedMeetingsForClient', () => {
  test('is tenant-scoped (NOT owner-scoped) and filters to shared, newest-shared first', async () => {
    let findArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      meeting: {
        findMany: async (args: Record<string, unknown>) => {
          findArgs = args;
          return [meetingRow({ visibility: 'shared', sharedByUserId: 'user-1' })];
        },
      },
      ...decorateStubs,
      ...tenantFlag(false),
    });

    const res = (await service.listSharedMeetingsForClient(ctx, 'c1')) as Array<
      Record<string, unknown>
    >;

    const where = findArgs!.where as Record<string, unknown>;
    expect(where).toEqual({ tenantId: 'tenant-1', clientId: 'c1', visibility: 'shared', status: { not: 'deleted' } });
    // Deliberately NO ownMeetingWhere — shared material is org-visible.
    expect(where).not.toHaveProperty('OR');
    expect(findArgs!.orderBy).toEqual([{ sharedAt: 'desc' }, { startsAt: 'desc' }]);
    expect(res[0]!.sharedBy).toEqual({ userId: 'user-1', name: 'Neo Martinez' });
  });
});

describe('decorateMeetings (via listSharedMeetingsForClient)', () => {
  test('a contributor whose only material is notes lists only "notes"; meri null when no session', async () => {
    const service = serviceWith({
      meeting: {
        findMany: async () => [
          meetingRow({
            // Phase 2 §d — filterToSharedArtifacts (run before decoration)
            // narrows to sharedAt != null; decorateMeetings then requires
            // status: 'approved' for notesApproved. Both are needed here.
            notes: [{ id: 'n1', status: 'approved', sharedAt: new Date('2026-07-01T00:00:00Z') }],
            debriefs: [{ status: 'generated' }],
            preps: [],
          }),
        ],
      },
      ...decorateStubs,
      ...tenantFlag(false),
    });

    const [row] = (await service.listSharedMeetingsForClient(ctx, 'c1')) as Array<
      Record<string, unknown>
    >;

    expect(row!.notesApproved).toBe(true);
    expect(row!.meri).toBeNull();
    // Only approved artifacts count; an unapproved debrief is excluded.
    expect(row!.contributors).toEqual([
      { userId: 'user-1', name: 'Neo Martinez', artifacts: ['notes'] },
    ]);
  });

  // A session that did NOT capture the meeting for a reason the user didn't ask
  // for must be surfaced as `meri: 'failed'` + a `meriError` explanation, NOT
  // silently collapsed to null (which reads as "Meri was never sent").
  test.each([
    [
      'denied_consent',
      null,
      'A participant declined to consent to recording, so Meri was removed from the call before it could take notes.',
    ],
    [
      'no_show',
      null,
      "Meri didn't make it into the call — it may not have been admitted from the waiting room in time.",
    ],
    ['failed', 'Recall reported a fatal error mid-call.', 'Recall reported a fatal error mid-call.'],
    ['failed', null, 'Meri hit an unexpected error and could not capture this meeting.'],
  ])('meri: %s / error: %s surfaces as failed with an explanation', async (status, error, expected) => {
    const service = serviceWith({
      meeting: {
        findMany: async () => [
          meetingRow({
            notes: [],
            debriefs: [],
            preps: [],
          }),
        ],
      },
      ...decorateStubs,
      meetingBotSession: { findMany: async () => [{ meetingId: 'm1', status, error }] },
      ...tenantFlag(false),
    });

    const [row] = (await service.listSharedMeetingsForClient(ctx, 'c1')) as Array<
      Record<string, unknown>
    >;

    expect(row!.meri).toBe('failed');
    expect(row!.meriError).toBe(expected);
  });

  // `removed` is the user's OWN "Cancel Meri" kill switch — unlike the failure
  // statuses above, this must stay silent (meri null, no meriError) so the UI
  // simply re-offers "Send Meri", which is exactly what the user asked for.
  test('meri: removed (user-cancelled) stays null with no meriError', async () => {
    const service = serviceWith({
      meeting: {
        findMany: async () => [meetingRow({ notes: [], debriefs: [], preps: [] })],
      },
      ...decorateStubs,
      meetingBotSession: {
        findMany: async () => [{ meetingId: 'm1', status: 'removed', error: null }],
      },
      ...tenantFlag(false),
    });

    const [row] = (await service.listSharedMeetingsForClient(ctx, 'c1')) as Array<
      Record<string, unknown>
    >;

    expect(row!.meri).toBeNull();
    expect(row!.meriError).toBeNull();
  });
});

describe('Phase 2 cross-user grouping (listSharedMeetingsForClient + meetingsCrossUser flag)', () => {
  const twoContributorTx = () => ({
    tenant: {
      findFirst: async () => ({
        settings: { clioFeatureFlags: { 'meetingsCrossUser.enabled': true } },
      }),
    },
    meeting: {
      findMany: async () => [
        // Newest-shared first (as the real query orders). Same iCalUId = one meeting.
        meetingRow({
          id: 'mB',
          createdByUserId: 'user-2',
          sharedByUserId: 'user-2',
          visibility: 'shared',
          iCalUId: 'ICAL-1',
          sharedAt: new Date('2026-07-03T00:00:00Z'),
          startsAt: new Date('2026-07-02T15:00:00Z'),
          // Phase 2 §d — filterToSharedArtifacts (run before decoration)
          // narrows to sharedAt != null per-artifact, on top of decoration's
          // own status: 'approved' requirement. Both are needed on each row.
          preps: [{ status: 'approved', sharedAt: new Date('2026-07-03T00:00:00Z') }],
        }),
        meetingRow({
          id: 'mA',
          createdByUserId: 'user-1',
          sharedByUserId: 'user-1',
          visibility: 'shared',
          iCalUId: 'ICAL-1',
          sharedAt: new Date('2026-07-01T00:00:00Z'),
          startsAt: new Date('2026-07-02T15:00:00Z'),
          notes: [{ id: 'n1', status: 'approved', sharedAt: new Date('2026-07-01T00:00:00Z') }],
          debriefs: [{ status: 'approved', sharedAt: new Date('2026-07-01T00:00:00Z') }],
        }),
      ],
    },
    user: {
      findMany: async () => [
        { id: 'user-1', firstName: 'Neo', lastName: 'Martinez', email: 'neo@capiro.ai' },
        { id: 'user-2', firstName: 'Lia', lastName: 'Park', email: 'lia@capiro.ai' },
      ],
    },
    meetingBotSession: {
      findMany: async () => [
        { meetingId: 'mA', status: 'done' },
        { meetingId: 'mB', status: 'recording' },
      ],
    },
  });

  test('collapses same-iCalUId shared rows into one record; first-sharer primary; notes canonical', async () => {
    const service = serviceWith(twoContributorTx());
    const res = (await service.listSharedMeetingsForClient(ctx, 'c1')) as Array<
      Record<string, unknown>
    >;

    expect(res).toHaveLength(1);
    const rec = res[0]!;
    // First sharer (earliest sharedAt = mA / user-1) is the primary contributor.
    const contributors = rec.contributors as Array<{ userId: string; artifacts: string[] }>;
    expect(contributors).toHaveLength(2);
    expect(contributors[0]!.userId).toBe('user-1');
    expect(contributors[0]!.artifacts.sort()).toEqual(['debrief', 'notes']);
    expect(contributors[1]!.userId).toBe('user-2');
    expect(contributors[1]!.artifacts).toEqual(['prep']);
    // Notes canonical (any member) + both bots attributed (§4.4).
    expect(rec.notesApproved).toBe(true);
    expect((rec.notetakers as string[]).sort()).toEqual(['Lia Park', 'Neo Martinez']);
    expect(rec.groupedMeetingIds).toEqual(['mA', 'mB']);
  });

  test('flag OFF → no grouping (two rows stay two records)', async () => {
    // Override just the tenant stub to turn the flag off.
    const service = serviceWith({ ...twoContributorTx(), ...tenantFlag(false) });
    const res = (await service.listSharedMeetingsForClient(ctx, 'c1')) as unknown[];
    expect(res).toHaveLength(2);
  });
});
