// Engagement Phase 2 §e: per-artifact share/unshare (ENGAGEMENT_ARTIFACT_SHARING_V2),
// the replacement for whole-meeting sharing driving the new ShareConfirmation UI.
// shareMeeting/unshareMeeting (whole-meeting) and listSharedMeetingsForClient's
// "shared feed omits private artifacts" behavior are already covered by
// engagement-meetings.spec.ts — this file is scoped to shareArtifacts/
// unshareArtifacts specifically, which had no direct coverage anywhere in the
// repo (found during independent QA of the Phase 2 ship). Uses the same
// minimal-harness pattern as its sibling spec files (a real EngagementService
// prototype over a stubbed prisma) so the heavy constructor graph isn't wired.

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

const otherUserCtx: TenantContext = { ...ctx, userId: 'user-2' };
const adminCtx: TenantContext = { ...ctx, role: 'user_admin' };

function serviceWith(tx: Record<string, unknown>): EngagementService {
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(tx),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  (service as unknown as { prisma: unknown }).prisma = prisma;
  return service;
}

const decorateStubs = {
  user: { findMany: async () => [] as Array<{ id: string }> },
  meetingBotSession: { findMany: async () => [] as Array<{ meetingId: string; status: string }> },
};

// shareArtifacts/unshareArtifacts both call meeting.findFirst twice: once for
// the initial existence/ownership check (a minimal shape suffices), and again
// afterward to refetch the full row that decorateMeetings needs
// (notes/debriefs/preps). Returns `first` on call 1, `after` on every call
// after that.
function sequencedMeetingFindFirst(first: unknown, after: unknown) {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1 ? first : after;
  };
}

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
    ...overrides,
  };
}

describe('shareArtifacts', () => {
  test('refuses an empty artifact list', async () => {
    const service = serviceWith({});
    await expect(service.shareArtifacts(ctx, 'm1', [])).rejects.toThrow(/must not be empty/i);
  });

  test('throws when the meeting is not found / not owned', async () => {
    const service = serviceWith({ meeting: { findFirst: async () => null } });
    await expect(
      service.shareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]),
    ).rejects.toThrow('Meeting not found');
  });

  test('refuses a meeting with no associated client', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1', clientId: null, visibility: 'private' }) },
    });
    await expect(
      service.shareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]),
    ).rejects.toThrow(/associated with a client/i);
  });

  test('rejects when a requested artifact does not exist on this meeting', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1', clientId: 'c1', visibility: 'private' }) },
      meetingNote: { findFirst: async () => null },
    });
    await expect(
      service.shareArtifacts(ctx, 'm1', [{ type: 'note', id: 'missing' }]),
    ).rejects.toThrow(/not found on this meeting/i);
  });

  test('only approved artifacts can be shared — an unapproved note blocks the whole call', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1', clientId: 'c1', visibility: 'private' }) },
      meetingNote: {
        findFirst: async () => ({
          status: 'draft',
          sharedAt: null,
          sharedByUserId: null,
          authorUserId: 'user-1',
        }),
      },
    });
    await expect(
      service.shareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]),
    ).rejects.toThrow(/only approved artifacts can be shared/i);
  });

  test('stamps sharedAt/sharedByUserId on each approved artifact and flips meeting visibility to shared', async () => {
    let noteUpdateArgs: Record<string, unknown> | undefined;
    let meetingUpdateArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      meeting: {
        findFirst: sequencedMeetingFindFirst(
          { id: 'm1', clientId: 'c1', visibility: 'private' },
          meetingRow({ visibility: 'shared' }),
        ),
        update: async (args: Record<string, unknown>) => {
          meetingUpdateArgs = args;
          return meetingRow();
        },
      },
      meetingNote: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: null,
          sharedByUserId: null,
          authorUserId: 'user-1',
        }),
        update: async (args: Record<string, unknown>) => {
          noteUpdateArgs = args;
          return {};
        },
      },
      ...decorateStubs,
    });

    await service.shareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]);

    expect((noteUpdateArgs!.data as Record<string, unknown>).sharedAt).toBeInstanceOf(Date);
    expect((noteUpdateArgs!.data as Record<string, unknown>).sharedByUserId).toBe('user-1');
    expect((meetingUpdateArgs!.data as Record<string, unknown>).visibility).toBe('shared');
  });

  test('is idempotent — an artifact already shared is not re-stamped, and meeting.visibility is left alone if already shared', async () => {
    let noteUpdateCalled = false;
    let meetingUpdateCalled = false;
    const service = serviceWith({
      meeting: {
        findFirst: sequencedMeetingFindFirst(
          { id: 'm1', clientId: 'c1', visibility: 'shared' },
          meetingRow({ visibility: 'shared' }),
        ),
        update: async () => {
          meetingUpdateCalled = true;
          return meetingRow();
        },
      },
      meetingNote: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date('2026-07-01T00:00:00Z'),
          sharedByUserId: 'user-2',
          authorUserId: 'user-1',
        }),
        update: async () => {
          noteUpdateCalled = true;
          return {};
        },
      },
      ...decorateStubs,
    });

    await service.shareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]);

    expect(noteUpdateCalled).toBe(false);
    expect(meetingUpdateCalled).toBe(false);
  });
});

describe('unshareArtifacts', () => {
  test('refuses an empty artifact list', async () => {
    const service = serviceWith({});
    await expect(service.unshareArtifacts(ctx, 'm1', [])).rejects.toThrow(/must not be empty/i);
  });

  test('throws when the meeting does not exist in this tenant', async () => {
    const service = serviceWith({ meeting: { findFirst: async () => null } });
    await expect(
      service.unshareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]),
    ).rejects.toThrow('Meeting not found');
  });

  test('tenant-scoped, not owner-scoped — an admin can act on a meeting they do not personally own', async () => {
    let findArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      meeting: {
        findFirst: (() => {
          let calls = 0;
          return async (args: Record<string, unknown>) => {
            calls += 1;
            if (calls === 1) {
              findArgs = args;
              return { id: 'm1' };
            }
            return meetingRow();
          };
        })(),
      },
      meetingNote: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date(),
          sharedByUserId: 'user-2',
          authorUserId: 'user-2',
        }),
        update: async () => ({}),
      },
      meetingPrep: { findFirst: async () => null },
      meetingDebrief: { findFirst: async () => null },
      engagementAttachment: { findFirst: async () => null },
      ...decorateStubs,
    });

    await service.unshareArtifacts(adminCtx, 'm1', [{ type: 'note', id: 'n1' }]);

    const where = findArgs!.where as Record<string, unknown>;
    expect(where).not.toHaveProperty('OR');
  });

  test('rejects when a requested artifact does not exist on this meeting', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: { findFirst: async () => null },
    });
    await expect(
      service.unshareArtifacts(ctx, 'm1', [{ type: 'note', id: 'missing' }]),
    ).rejects.toThrow(/not found on this meeting/i);
  });

  test('a standard user may unshare an artifact they personally shared', async () => {
    const service = serviceWith({
      meeting: { findFirst: sequencedMeetingFindFirst({ id: 'm1' }, meetingRow()) },
      meetingNote: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date(),
          sharedByUserId: 'user-1',
          authorUserId: 'user-2',
        }),
        update: async () => ({}),
      },
      meetingPrep: { findFirst: async () => null },
      meetingDebrief: { findFirst: async () => null },
      engagementAttachment: { findFirst: async () => null },
      ...decorateStubs,
    });

    await expect(
      service.unshareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]),
    ).resolves.toBeDefined();
  });

  test('a standard user may unshare a note/debrief they authored, even if someone else shared it', async () => {
    const service = serviceWith({
      meeting: { findFirst: sequencedMeetingFindFirst({ id: 'm1' }, meetingRow()) },
      meetingNote: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date(),
          sharedByUserId: 'user-2',
          authorUserId: 'user-1',
        }),
        update: async () => ({}),
      },
      meetingPrep: { findFirst: async () => null },
      meetingDebrief: { findFirst: async () => null },
      engagementAttachment: { findFirst: async () => null },
      ...decorateStubs,
    });

    await expect(
      service.unshareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]),
    ).resolves.toBeDefined();
  });

  test('a standard user CANNOT unshare a prep they neither shared nor have any author concept for', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingPrep: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date(),
          sharedByUserId: 'user-2',
        }),
      },
    });

    await expect(
      service.unshareArtifacts(ctx, 'm1', [{ type: 'prep', id: 'p1' }]),
    ).rejects.toThrow(/not authorized to unshare/i);
  });

  test('all-or-nothing: one unauthorized artifact in the batch rejects the WHOLE batch — the authorized one is not unshared either', async () => {
    let noteUpdateCalled = false;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date(),
          sharedByUserId: 'user-1', // authorized for this one
          authorUserId: null,
        }),
        update: async () => {
          noteUpdateCalled = true;
          return {};
        },
      },
      meetingPrep: {
        findFirst: async () => ({
          status: 'approved',
          sharedAt: new Date(),
          sharedByUserId: 'user-2', // NOT authorized for this one
        }),
      },
    });

    await expect(
      service.unshareArtifacts(ctx, 'm1', [
        { type: 'note', id: 'n1' },
        { type: 'prep', id: 'p1' },
      ]),
    ).rejects.toThrow(/not authorized to unshare/i);
    expect(noteUpdateCalled).toBe(false);
  });

  test('unsharing the LAST shared artifact resets Meeting.visibility to private', async () => {
    let meetingUpdateArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      meeting: {
        findFirst: sequencedMeetingFindFirst({ id: 'm1' }, meetingRow({ visibility: 'private' })),
        update: async (args: Record<string, unknown>) => {
          meetingUpdateArgs = args;
          return meetingRow();
        },
      },
      meetingNote: {
        // 1st call: loadArtifactShareState's pre-unshare lookup of n1 (must be
        // approved+shared to authorize). 2nd+ call: recomputeMeetingVisibility's
        // post-unshare check for ANY still-shared note — null, since n1 (the
        // only note) was just unshared.
        findFirst: sequencedMeetingFindFirst(
          { status: 'approved', sharedAt: new Date(), sharedByUserId: 'user-1', authorUserId: null },
          null,
        ),
        update: async () => ({}),
      },
      meetingPrep: { findFirst: async () => null },
      meetingDebrief: { findFirst: async () => null },
      engagementAttachment: { findFirst: async () => null },
      ...decorateStubs,
    });

    await service.unshareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]);

    expect(meetingUpdateArgs).toBeDefined();
    const data = meetingUpdateArgs!.data as Record<string, unknown>;
    expect(data.visibility).toBe('private');
    expect(data.sharedAt).toBeNull();
    expect(data.sharedByUserId).toBeNull();
  });

  test('leaves Meeting.visibility as shared when another artifact is still shared', async () => {
    let meetingUpdateCalled = false;
    const service = serviceWith({
      meeting: {
        findFirst: sequencedMeetingFindFirst({ id: 'm1' }, meetingRow({ visibility: 'shared' })),
        update: async () => {
          meetingUpdateCalled = true;
          return meetingRow();
        },
      },
      meetingNote: {
        // 1st call: pre-unshare lookup of n1. 2nd+ call: recompute's
        // still-shared check — non-null, simulating a different note (n2)
        // remains shared.
        findFirst: sequencedMeetingFindFirst(
          { status: 'approved', sharedAt: new Date(), sharedByUserId: 'user-1', authorUserId: null },
          { id: 'n2' },
        ),
        update: async () => ({}),
      },
      meetingPrep: { findFirst: async () => null },
      meetingDebrief: { findFirst: async () => null },
      engagementAttachment: { findFirst: async () => null },
      ...decorateStubs,
    });

    await service.unshareArtifacts(ctx, 'm1', [{ type: 'note', id: 'n1' }]);

    expect(meetingUpdateCalled).toBe(false);
  });
});
