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

// Current-member rows are bound to this test actor, not to whichever request
// happens to arrive. Admin cases must explicitly supply their active admin.
function transactionFixture(tx: Record<string, unknown>, actor: TenantContext = ctx) {
  return {
    tenantMembership: {
      findFirst: async ({
        where,
      }: {
        where: { tenantId: string; userId: string; status: string; user: { clerkUserId: string } };
      }) =>
        where.tenantId === actor.tenantId &&
        where.userId === actor.userId &&
        where.status === 'active' &&
        where.user.clerkUserId === actor.clerkUserId
          ? { role: actor.role }
          : null,
    },
    client: { findFirst: async () => ({ id: 'c1', primaryContactEmail: null }) },
    clientPerson: { findMany: async () => [] },
    $queryRaw: async () => [],
    $queryRawUnsafe: async () => [{ allowed: true }],
    ...tx,
  };
}

function serviceWith(tx: Record<string, unknown>, actor: TenantContext = ctx): EngagementService {
  const scoped = transactionFixture(tx, actor);
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(scoped),
    withTenantUser: (_tenantId: string, _userId: string, fn: (scoped: unknown) => unknown) =>
      fn(scoped),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  (service as unknown as { prisma: unknown }).prisma = prisma;
  return service;
}

// A meeting row shaped like meetingInclude() output, enough for decorateMeetings.
function meetingRow(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'm1',
    createdByUserId: 'user-1',
    sharedByUserId: null,
    clientId: 'c1',
    visibility: 'private',
    notes: [] as Array<Record<string, unknown>>,
    debriefs: [] as Array<Record<string, unknown>>,
    preps: [],
    // Phase 2 §d — filterToSharedArtifacts (run on every row inside
    // listSharedMeetingsForClient) narrows this down to sharedAt != null.
    attachments: [],
    ...overrides,
  };
  return {
    ...row,
    notes: row.notes.map((entry) => ({ updatedAt: new Date('2026-10-21T12:00:00Z'), ...entry })),
    debriefs: row.debriefs.map((entry) => ({
      updatedAt: new Date('2026-10-21T12:00:00Z'),
      ...entry,
    })),
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

describe('createMeeting current authority', () => {
  const input = {
    subject: 'Synthetic meeting',
    startsAt: '2026-10-24T12:00:00Z',
    endsAt: '2026-10-24T13:00:00Z',
  };
  function createHarness(reason?: 'member' | 'client' | 'wall', associated: string | null = null) {
    let contactsWritten = 0;
    let meetingsWritten = 0;
    const service = serviceWith({
      ...decorateStubs,
      ...(reason === 'member' ? { tenantMembership: { findFirst: async () => null } } : {}),
      client: { findFirst: async () => (reason === 'client' ? null : { id: 'c1' }) },
      $queryRawUnsafe: async () => [{ allowed: reason !== 'wall' }],
      meeting: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          meetingsWritten += 1;
          return meetingRow(data);
        },
      },
    });
    Object.assign(service, {
      association: {
        associate: async () => ({
          clientId: associated,
          score: 0,
          reason: 'Synthetic',
          signals: {},
        }),
      },
      upsertAttendeeContacts: async () => {
        contactsWritten += 1;
        return new Map();
      },
    });
    return { service, writes: () => ({ contactsWritten, meetingsWritten }) };
  }
  test.each(['member', 'client', 'wall'] as const)(
    'refuses current %s denial before contact/meeting writes',
    async (reason) => {
      const h = createHarness(reason);
      await expect(h.service.createMeeting(ctx, { ...input, clientId: 'c1' })).rejects.toThrow(
        'Meeting not found',
      );
      expect(h.writes()).toEqual({ contactsWritten: 0, meetingsWritten: 0 });
    },
  );
  test('checks an automatically associated client before writes', async () => {
    const h = createHarness('wall', 'c1');
    await expect(h.service.createMeeting(ctx, input)).rejects.toThrow('Meeting not found');
    expect(h.writes()).toEqual({ contactsWritten: 0, meetingsWritten: 0 });
  });
  test('an explicitly reviewed no-client create does not auto-associate', async () => {
    const h = createHarness(undefined, 'c1');
    await expect(h.service.createMeeting(ctx, { ...input, clientId: null })).resolves.toMatchObject({
      clientId: null,
      createdByUserId: ctx.userId,
    });
    expect(h.writes()).toEqual({ contactsWritten: 1, meetingsWritten: 1 });
  });
  test.each(['manual', 'automatic', 'unassociated'])(
    'preserves an authorized %s create',
    async (mode) => {
      const h = createHarness(undefined, mode === 'automatic' ? 'c1' : null);
      await expect(
        h.service.createMeeting(ctx, mode === 'manual' ? { ...input, clientId: 'c1' } : input),
      ).resolves.toMatchObject({
        clientId: mode === 'unassociated' ? null : 'c1',
        createdByUserId: ctx.userId,
      });
      expect(h.writes()).toEqual({ contactsWritten: 1, meetingsWritten: 1 });
    },
  );
});

describe('getClientMeeting', () => {
  test('resolves a null-client meeting through the canonical contact association and current wall', async () => {
    let meetingWhere: Record<string, unknown> | undefined;
    const row = meetingRow({ clientId: null, subject: 'Associated meeting' });
    const service = serviceWith({
      client: {
        findFirst: async () => ({ id: 'c1', primaryContactEmail: 'contact@example.test' }),
      },
      clientPerson: { findMany: async () => [{ email: 'person@example.test' }] },
      meeting: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          meetingWhere = args.where;
          return row;
        },
      },
      $queryRawUnsafe: async () => [{ allowed: true }],
    });

    await expect(service.getClientMeeting(ctx, 'c1', 'm1')).resolves.toBe(row);
    expect(meetingWhere).toEqual({
      AND: [
        {
          id: 'm1',
          tenantId: 'tenant-1',
          OR: [{ createdByUserId: 'user-1' }, { connection: { createdByUserId: 'user-1' } }],
          status: { not: 'deleted' },
        },
        expect.objectContaining({
          OR: expect.arrayContaining([
            { clientId: 'c1' },
            expect.objectContaining({ clientId: null, isInternal: false }),
          ]),
        }),
      ],
    });
  });

  test('fails closed for a current parent/link mismatch or wall revocation', async () => {
    const base = {
      client: { findFirst: async () => ({ id: 'c1', primaryContactEmail: null }) },
      clientPerson: { findMany: async () => [] },
    };
    const missing = serviceWith({
      ...base,
      meeting: { findFirst: async () => null },
      $queryRawUnsafe: async () => [{ allowed: true }],
    });
    await expect(missing.getClientMeeting(ctx, 'c1', 'm1')).rejects.toThrow('Meeting not found');

    const revoked = serviceWith({
      ...base,
      meeting: { findFirst: async () => meetingRow() },
      $queryRawUnsafe: async () => [{ allowed: false }],
    });
    await expect(revoked.getClientMeeting(ctx, 'c1', 'm1')).rejects.toThrow('Client not found');
  });
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
        findFirst: async () => ({ id: 'm1', clientId: null }),
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
  const visibleClientPredicate = {
    OR: [
      { clientId: null },
      {
        client: {
          is: {
            tenantId: ctx.tenantId,
            status: { not: 'archived' },
            OR: [
              { memoryWall: false },
              { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } },
            ],
          },
        },
      },
    ],
  };

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
    expect(where.AND).toEqual([
      visibleClientPredicate,
      { debriefs: { some: { status: 'approved' } } },
    ]);
    expect(findArgs!.skip).toBe(10);
    expect(findArgs!.take).toBe(10);
    expect(findArgs!.orderBy).toEqual({ startsAt: 'desc' });
    // count runs on the same where.
    expect((countArgs!.where as Record<string, unknown>).AND).toEqual(where.AND);
  });

  test('search AND-s an OR over subject and client name, without touching the owner OR', async () => {
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

    await service.listMeetingLibrary(ctx, { search: '  HASC  ' });

    const where = findArgs!.where as Record<string, unknown>;

    /*
     * THE important assertion. `ownMeetingWhere()` returns its own top-level
     * `OR`, and it is the authorization predicate. Putting the search in a
     * second top-level `OR` would OVERWRITE it and silently widen the query from
     * "meetings I own" to "every meeting in the tenant whose subject matches" —
     * a cross-user data leak, not a display bug. The owner OR must survive
     * untouched.
     */
    expect(where.OR).toEqual([
      { createdByUserId: 'user-1' },
      { connection: { createdByUserId: 'user-1' } },
    ]);

    // Trimmed, case-insensitive, and over metadata only — never artifact bodies,
    // which are stored encrypted and are not decrypted on list endpoints.
    expect(where.AND).toEqual([
      visibleClientPredicate,
      {
        OR: [
          { preps: { some: { status: 'approved' } } },
          { debriefs: { some: { status: 'approved' } } },
          { notes: { some: { status: 'approved' } } },
        ],
      },
      {
        OR: [
          { subject: { contains: 'HASC', mode: 'insensitive' } },
          { client: { name: { contains: 'HASC', mode: 'insensitive' } } },
        ],
      },
    ]);

    // The count must apply the search too, or the pager claims more pages than
    // the search actually has.
    expect((countArgs!.where as Record<string, unknown>).AND).toEqual(where.AND);
  });

  test.each([undefined, '', '   '])('search %p adds no predicate', async (search) => {
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

    await service.listMeetingLibrary(ctx, { search, artifactType: 'notes' });

    // Only the client visibility and artifact filters. A whitespace-only search must
    // not become `contains: ''`, which matches every row and would make the
    // query look filtered while filtering nothing.
    expect((findArgs!.where as Record<string, unknown>).AND).toEqual([
      visibleClientPredicate,
      { notes: { some: { status: 'approved' } } },
    ]);
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
      visibleClientPredicate,
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

  describe('EM-08 — libraryQualifiedBy (why a row is actually in the Library)', () => {
    // Real regenerate-then-approve-drifts scenario: the meeting's CURRENT
    // prep (what meetingInclude()'s take:1 returns, and what the Prep tab/
    // MaterialBadges show) is unapproved, but an OLDER prep row for the same
    // meeting was approved and generateMeetingPrep never rewrites it —  it's
    // a historical fact, left alone. libraryArtifactWhere's unbounded
    // `preps: { some: { status: 'approved' } }` is why the row is still
    // listed; libraryQualifiedBy must say so honestly instead of leaving
    // "Materials —" unexplained.
    function harnessFor(opts: {
      approvedPrepMeetingIds: string[];
      currentPrepStatusByMeeting: Record<string, string>;
      approvedNoteMeetingIds: string[];
      approvedDebriefMeetingIds: string[];
      row: Record<string, unknown>;
    }) {
      let prepFindManyCall = 0;
      return serviceWith({
        meeting: {
          count: async () => 1,
          findMany: async () => [opts.row],
        },
        meetingPrep: {
          findMany: async (args: { distinct?: string[]; where: { status?: string } }) => {
            prepFindManyCall += 1;
            // First call: WHERE status = approved (finds historical approvals).
            if (prepFindManyCall === 1) {
              return opts.approvedPrepMeetingIds.map((meetingId) => ({ meetingId }));
            }
            // Second call: no status filter, orderBy createdAt desc, distinct
            // meetingId — the CURRENT (latest) prep per meeting.
            return Object.entries(opts.currentPrepStatusByMeeting).map(([meetingId, status]) => ({
              meetingId,
              status,
            }));
          },
        },
        meetingNote: {
          findMany: async () => opts.approvedNoteMeetingIds.map((meetingId) => ({ meetingId })),
        },
        meetingDebrief: {
          findMany: async () => opts.approvedDebriefMeetingIds.map((meetingId) => ({ meetingId })),
        },
        ...decorateStubs,
      });
    }

    test('a meeting whose ONLY qualifying artifact is a superseded (no-longer-current) approved prep gets current:false', async () => {
      const service = harnessFor({
        approvedPrepMeetingIds: ['m1'],
        currentPrepStatusByMeeting: { m1: 'generated' },
        approvedNoteMeetingIds: [],
        approvedDebriefMeetingIds: [],
        row: meetingRow({ preps: [{ status: 'generated' }] }),
      });

      const res = await service.listMeetingLibrary(ctx, {});

      expect(res.data).toHaveLength(1);
      expect((res.data[0] as { libraryQualifiedBy: unknown }).libraryQualifiedBy).toEqual([
        { kind: 'prep', current: false },
      ]);
    });

    test('a meeting whose current prep IS the approved one gets current:true', async () => {
      const service = harnessFor({
        approvedPrepMeetingIds: ['m1'],
        currentPrepStatusByMeeting: { m1: 'approved' },
        approvedNoteMeetingIds: [],
        approvedDebriefMeetingIds: [],
        row: meetingRow({ preps: [{ status: 'approved' }] }),
      });

      const res = await service.listMeetingLibrary(ctx, {});

      expect((res.data[0] as { libraryQualifiedBy: unknown }).libraryQualifiedBy).toEqual([
        { kind: 'prep', current: true },
      ]);
    });

    test('approved notes/debriefs are always current (they update in place, never mint a new row)', async () => {
      const service = harnessFor({
        approvedPrepMeetingIds: [],
        currentPrepStatusByMeeting: {},
        approvedNoteMeetingIds: ['m1'],
        approvedDebriefMeetingIds: ['m1'],
        row: meetingRow({
          notes: [{ status: 'approved' }],
          debriefs: [{ status: 'approved' }],
        }),
      });

      const res = await service.listMeetingLibrary(ctx, {});

      expect((res.data[0] as { libraryQualifiedBy: unknown }).libraryQualifiedBy).toEqual([
        { kind: 'notes', current: true },
        { kind: 'debrief', current: true },
      ]);
    });

    test('a meeting with no qualifying artifact at all gets an empty libraryQualifiedBy, never undefined', async () => {
      const service = harnessFor({
        approvedPrepMeetingIds: [],
        currentPrepStatusByMeeting: {},
        approvedNoteMeetingIds: [],
        approvedDebriefMeetingIds: [],
        row: meetingRow(),
      });

      const res = await service.listMeetingLibrary(ctx, {});

      expect((res.data[0] as { libraryQualifiedBy: unknown }).libraryQualifiedBy).toEqual([]);
    });
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
    expect(where).toEqual({
      tenantId: 'tenant-1',
      clientId: 'c1',
      visibility: 'shared',
      status: { not: 'deleted' },
    });
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
    [
      'failed',
      'Recall reported a fatal error mid-call.',
      'Recall reported a fatal error mid-call.',
    ],
    ['failed', null, 'Meri hit an unexpected error and could not capture this meeting.'],
  ])(
    'meri: %s / error: %s surfaces as failed with an explanation',
    async (status, error, expected) => {
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
    },
  );

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

// The engagement.meetings receiver types preps[].agenda / talkingPoints / risks
// / followUps as string[], while the canonical prep payload also accepts a
// structured `{ text, ...provenance }` entry and the titled `{ title, ... }`
// item stored on preps. ONE such entry used to fail the whole array — and with
// it the whole view (the retained master-scope 502).
describe('listMeetings prep list projection (receiver contract)', () => {
  const structuredPrep = (): Record<string, unknown> => ({
    id: 'p1',
    status: 'approved',
    summary: 'Synthetic prep',
    agenda: [{ text: 'Synthetic agenda item', factIds: ['fact-1'] }, 'Plain agenda item'],
    talkingPoints: [{ text: 'Synthetic talking point', evidenceReferences: ['fact-1'] }],
    risks: ['Plain risk'],
    followUps: [{ text: 'Synthetic follow-up', factIds: [] }],
    // Provenance and every other column must survive the projection untouched.
    generatedFrom: { contextPacketId: 'packet-1', factIds: ['fact-1'] },
  });

  async function listMaster(preps: Array<Record<string, unknown>>) {
    const service = serviceWith({
      meeting: { findMany: async () => [meetingRow({ preps })] },
      ...decorateStubs,
      ...tenantFlag(false),
    });
    const rows = (await service.listMeetings(ctx, {})) as Array<Record<string, unknown>>;
    return rows[0]!.preps as Array<Record<string, unknown>>;
  }

  test('recognized structured entries are projected to their text; everything else is preserved', async () => {
    const stored = structuredPrep();
    const snapshot = JSON.parse(JSON.stringify(stored));

    const [prep] = await listMaster([stored]);

    expect(prep!.agenda).toEqual(['Synthetic agenda item', 'Plain agenda item']);
    expect(prep!.talkingPoints).toEqual(['Synthetic talking point']);
    expect(prep!.risks).toEqual(['Plain risk']);
    expect(prep!.followUps).toEqual(['Synthetic follow-up']);
    // Unrelated prep data, including the structured provenance, is preserved.
    expect(prep!.summary).toBe('Synthetic prep');
    expect(prep!.status).toBe('approved');
    expect(prep!.generatedFrom).toEqual({ contextPacketId: 'packet-1', factIds: ['fact-1'] });
    // The stored row is never rewritten: its structured entries stay structured.
    expect(JSON.parse(JSON.stringify(stored))).toEqual(snapshot);
  });

  test('an entry without a valid metadata arm is passed through verbatim, so validation is not weakened', async () => {
    const stored = structuredPrep();
    const unshaped = { description: 'Not prep text' };
    const bareText = { text: 'Text without any metadata arm' };
    const nonArrayFactIds = { text: 'Non-array metadata', factIds: 'fact-1' };
    const nonStringFactIds = { text: 'Non-string metadata member', factIds: ['fact-1', 7] };
    const nonArrayReferences = { text: 'Non-array references', evidenceReferences: 'ref-1' };
    stored.agenda = [unshaped, 'Plain agenda item'];
    stored.talkingPoints = [bareText, nonArrayFactIds, 'Plain talking point'];
    stored.risks = [{ text: 42 }, { text: '   ' }, nonStringFactIds, nonArrayReferences];
    stored.followUps = [];

    const [prep] = await listMaster([stored]);

    // Nothing is dropped and nothing is coerced into a string — including a
    // text-bearing object whose provenance arm is missing or malformed, which
    // the receiver's union does not accept either.
    expect(prep!.agenda).toEqual([unshaped, 'Plain agenda item']);
    expect(prep!.talkingPoints).toEqual([bareText, nonArrayFactIds, 'Plain talking point']);
    expect(prep!.risks).toEqual([{ text: 42 }, { text: '   ' }, nonStringFactIds, nonArrayReferences]);
    expect(prep!.followUps).toEqual([]);
  });

  // The shape stored on the deployed preps: the synthetic master-scope prep
  // (5-week window, engagement.meetings master read) carries `{ title, ... }`
  // agenda/follow-up items, which the text-only recognition above left in place
  // — so the whole view kept failing on the receiver contract.
  test('the stored titled item arm is projected to its title', async () => {
    const stored = structuredPrep();
    const agendaTitle = { title: 'Synthetic agenda title', description: 'Not shown' };
    const followUpTitle = {
      title: 'Synthetic follow-up title',
      dueDate: '2026-10-05',
      description: 'Not shown',
    };
    stored.agenda = [agendaTitle, 'Plain agenda item'];
    stored.talkingPoints = [{ title: 'Synthetic talking point title' }];
    stored.risks = [{ title: 42 }, { title: '   ' }, 'Plain risk'];
    stored.followUps = [followUpTitle];

    const [prep] = await listMaster([stored]);

    expect(prep!.agenda).toEqual(['Synthetic agenda title', 'Plain agenda item']);
    expect(prep!.talkingPoints).toEqual(['Synthetic talking point title']);
    // A missing, wrong-typed or blank title is not a recognized arm.
    expect(prep!.risks).toEqual([{ title: 42 }, { title: '   ' }, 'Plain risk']);
    expect(prep!.followUps).toEqual(['Synthetic follow-up title']);
    // The stored row is never rewritten.
    const [storedAgendaItem] = stored.agenda as unknown[];
    const [storedFollowUpItem] = stored.followUps as unknown[];
    expect(storedAgendaItem).toBe(agendaTitle);
    expect(storedFollowUpItem).toBe(followUpTitle);
  });

  test('a malformed text arm is not rescued by a title', async () => {
    const stored = structuredPrep();
    const mixed = { text: 'Evidence text with no metadata arm', title: 'Synthetic title' };
    stored.agenda = [mixed];

    const [prep] = await listMaster([stored]);

    expect(prep!.agenda).toEqual([mixed]);
  });

  test('one valid metadata arm is enough — a malformed second arm does not block projection', async () => {
    const stored = structuredPrep();
    stored.risks = [
      { text: 'One valid arm', factIds: ['fact-1'], evidenceReferences: 'malformed' },
    ];

    const [prep] = await listMaster([stored]);

    expect(prep!.risks).toEqual(['One valid arm']);
  });

  test('a prep list column that is not an array is passed through unchanged', async () => {
    const stored = structuredPrep();
    stored.agenda = { text: 'Not a list' };

    const [prep] = await listMaster([stored]);

    expect(prep!.agenda).toEqual({ text: 'Not a list' });
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
