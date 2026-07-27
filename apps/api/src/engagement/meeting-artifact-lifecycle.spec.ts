// Engagement Phase 2 §d: per-artifact approval lifecycle. A note or attachment
// is never approved merely by existing — approval is always an explicit call —
// and editing an approved note/debrief resets it and clears any prior
// approval/share stamps. Prep approval keeps its pre-existing no-author-check
// behavior unchanged. Uses the same minimal-harness pattern as
// engagement-meetings.spec.ts (a real EngagementService prototype over a
// stubbed prisma) so the heavy constructor graph isn't wired.

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

function serviceWith(
  tx: Record<string, unknown>,
  patch: Record<string, unknown> = {},
): EngagementService {
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(tx),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const s = service as unknown as Record<string, unknown>;
  s.prisma = prisma;
  // createMeetingNote/updateMeetingNote/createMeetingDebrief/updateMeetingDebrief
  // all encrypt the body BEFORE opening a transaction.
  s.notesCrypto = {
    encrypt: () => ({ bodyCiphertext: 'ct', iv: 'iv', authTag: 'tag', keyVersion: 'v1' }),
  };
  Object.assign(s, patch);
  return service;
}

describe('note existence is not approval', () => {
  test('createMeetingNote never forces status — new notes rely on the column DEFAULT (draft)', async () => {
    let createArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1', clientId: 'c1' }) },
      meetingNote: {
        create: async (args: { data: Record<string, unknown> }) => {
          createArgs = args;
          return { id: 'n1' };
        },
      },
    });

    await service.createMeetingNote(ctx, 'm1', { body: 'raw notes' });

    expect(createArgs!.data).not.toHaveProperty('status');
    expect(createArgs!.data).not.toHaveProperty('approvedAt');
    expect(createArgs!.data).not.toHaveProperty('sharedAt');
  });
});

describe('approveMeetingNote', () => {
  test('throws when the note does not exist on this meeting', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: { findFirst: async () => null },
    });
    await expect(service.approveMeetingNote(ctx, 'm1', 'n1')).rejects.toThrow(
      'Meeting note not found',
    );
  });

  test('the author can approve their own note — stamps status/approvedAt/approvedByUserId', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: {
        findFirst: async () => ({ id: 'n1', authorUserId: 'user-1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'n1', status: 'approved' };
        },
      },
    });

    await service.approveMeetingNote(ctx, 'm1', 'n1');

    expect(updateArgs!.data.status).toBe('approved');
    expect(updateArgs!.data.approvedByUserId).toBe('user-1');
    expect(updateArgs!.data.approvedAt).toBeInstanceOf(Date);
  });

  test('a standard user who is neither author nor admin cannot approve someone else’s note', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: { findFirst: async () => ({ id: 'n1', authorUserId: 'user-2' }) },
    });

    await expect(service.approveMeetingNote(ctx, 'm1', 'n1')).rejects.toThrow(
      /only approve your own meeting notes/i,
    );
  });

  test('a user_admin can approve a note authored by someone else', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: {
        findFirst: async () => ({ id: 'n1', authorUserId: 'user-2' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'n1', status: 'approved' };
        },
      },
    });

    await service.approveMeetingNote(adminCtx, 'm1', 'n1');

    expect(updateArgs!.data.status).toBe('approved');
    // Stamped as the ACTING admin, not the author.
    expect(updateArgs!.data.approvedByUserId).toBe(adminCtx.userId);
  });
});

describe('updateMeetingNote — editing resets approval + share state', () => {
  test('editing a note sets status=edited and clears approvedAt/approvedByUserId/sharedAt/sharedByUserId', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: {
        findFirst: async () => ({ id: 'n1', authorUserId: 'user-1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'n1', status: 'edited' };
        },
      },
    });

    await service.updateMeetingNote(ctx, 'm1', 'n1', { body: 'revised text' });

    expect(updateArgs!.data.status).toBe('edited');
    expect(updateArgs!.data.approvedAt).toBeNull();
    expect(updateArgs!.data.approvedByUserId).toBeNull();
    expect(updateArgs!.data.sharedAt).toBeNull();
    expect(updateArgs!.data.sharedByUserId).toBeNull();
  });

  test('a non-author, non-admin cannot edit someone else’s note', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingNote: { findFirst: async () => ({ id: 'n1', authorUserId: 'user-2' }) },
    });
    await expect(
      service.updateMeetingNote(ctx, 'm1', 'n1', { body: 'hijacked edit' }),
    ).rejects.toThrow(/only edit your own meeting notes/i);
  });
});

describe('updateMeetingDebrief — editing clears the (new) share stamp', () => {
  test('editing a debrief resets status=edited (existing behavior) and now also clears sharedAt/sharedByUserId', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      meetingDebrief: {
        findFirst: async () => ({ id: 'd1', authorUserId: 'user-1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'd1', status: 'edited' };
        },
      },
    });

    await service.updateMeetingDebrief(ctx, 'm1', 'd1', { body: 'revised debrief' });

    expect(updateArgs!.data.status).toBe('edited');
    expect(updateArgs!.data.sharedAt).toBeNull();
    expect(updateArgs!.data.sharedByUserId).toBeNull();
  });
});

describe('approveMeetingAttachment — single-user approval (Neo decision)', () => {
  test('throws when the attachment is not found on this meeting', async () => {
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      engagementAttachment: { findFirst: async () => null },
    });
    await expect(service.approveMeetingAttachment(ctx, 'm1', 'a1')).rejects.toThrow(
      'Attachment not found',
    );
  });

  test('the uploader can approve their own upload — no second reviewer required', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      engagementAttachment: {
        // No author/uploader check anywhere in the lookup or the gate — any
        // user with access to the meeting may approve. This row IS the
        // caller's own upload (uploadedByUserId would equal ctx.userId in a
        // real row); approveMeetingAttachment doesn't even read that field.
        findFirst: async () => ({ id: 'a1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'a1', approvedAt: new Date() };
        },
      },
    });

    await service.approveMeetingAttachment(ctx, 'm1', 'a1');

    expect(updateArgs!.data.approvedByUserId).toBe('user-1');
    expect(updateArgs!.data.approvedAt).toBeInstanceOf(Date);
  });

  test('a different user (not the uploader) can also approve — single-user, not self-only', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meeting: { findFirst: async () => ({ id: 'm1' }) },
      engagementAttachment: {
        findFirst: async () => ({ id: 'a1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'a1', approvedAt: new Date() };
        },
      },
    });

    await service.approveMeetingAttachment(otherUserCtx, 'm1', 'a1');

    expect(updateArgs!.data.approvedByUserId).toBe('user-2');
  });
});

describe('approveMeetingPrep — unchanged: no per-item author check', () => {
  test('approving a prep never checks an author field — only ensureOwnMeeting (meeting ownership) gates it', async () => {
    let updateArgs: { data: Record<string, unknown> } | undefined;
    const service = serviceWith({
      meetingPrep: {
        findFirst: async () => ({ id: 'p1', meetingId: 'm1' }),
        update: async (args: { data: Record<string, unknown> }) => {
          updateArgs = args;
          return { id: 'p1', status: 'approved' };
        },
      },
      meeting: { findFirst: async () => ({ id: 'm1' }) }, // ensureOwnMeeting
    });

    await service.approveMeetingPrep(ctx, 'p1');

    expect(updateArgs!.data.status).toBe('approved');
    expect(updateArgs!.data.editedByUserId).toBe('user-1');
    // Deliberately no assertion about an author/uploader match — the
    // service never loads or checks one for prep (see the plan's Neo-decision
    // note: prep keeps its existing no-author-check gate unchanged).
  });
});
