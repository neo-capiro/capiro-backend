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
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn({ $queryRaw: async () => [], ...tx }),
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

  test('createMeetingNote opens withTenant with extended timeout headroom', async () => {
    // Prod 2026-08-20: Meri notes save failed after a successful transcript because
    // prisma.withTenant defaulted to 5000ms and the interactive tx expired mid-write.
    let capturedOpts: { timeoutMs?: number } | undefined;
    const prisma = {
      withTenant: (
        _tenantId: string,
        fn: (scoped: unknown) => unknown,
        opts?: { timeoutMs?: number },
      ) => {
        capturedOpts = opts;
        return fn({
          $queryRaw: async () => [],
          meeting: { findFirst: async () => ({ id: 'm1', clientId: 'c1' }) },
          meetingNote: { create: async () => ({ id: 'n1' }) },
        });
      },
    };
    const service = Object.create(EngagementService.prototype) as EngagementService;
    const s = service as unknown as Record<string, unknown>;
    s.prisma = prisma;
    s.notesCrypto = {
      encrypt: () => ({ bodyCiphertext: 'ct', iv: 'iv', authTag: 'tag', keyVersion: 'v1' }),
    };

    await service.createMeetingNote(ctx, 'm1', { body: 'raw notes' });

    expect(capturedOpts?.timeoutMs).toBeGreaterThanOrEqual(20_000);
  });

  test('generateMeetingDebriefDraft context load opens withTenant with extended timeout headroom', async () => {
    // Same 5s default that killed Meri notes also wraps the heavy prep/debrief
    // context pack (recent threads + association SQL). First-click prep fails
    // under cold Aurora; retry often succeeds once warm.
    let capturedOpts: { timeoutMs?: number } | undefined;
    const prisma = {
      withTenant: async (
        _tenantId: string,
        fn: (scoped: unknown) => unknown,
        opts?: { timeoutMs?: number },
      ) => {
        capturedOpts = opts;
        return fn({
          meeting: {
            findFirst: async () => ({
              id: 'm1',
              clientId: null,
              client: null,
              attendees: [],
              attachments: [],
              preps: [],
              tasks: [],
              subject: 'x',
              startsAt: new Date(),
              endsAt: new Date(),
            }),
          },
        });
      },
    };
    const service = Object.create(EngagementService.prototype) as EngagementService;
    const s = service as unknown as Record<string, unknown>;
    s.prisma = prisma;
    s.listMeetingNotes = async () => [];
    s.clientContext = async () => null;
    s.directoryProfilesForMeeting = async () => [];
    s.loadUserVoiceBlock = async () => null;
    s.recordAiUsage = async () => undefined;
    s.ai = {
      generateMeetingDebrief: async () => ({
        recap: 'r',
        actionItems: [],
        notes: 'n',
        provider: 'openai',
        model: 'm',
      }),
    };
    s.resolveEffectiveMeetingClientId = async () => null;

    await service.generateMeetingDebriefDraft(ctx, 'm1', {
      method: 'upload',
      sourceText: 'hello transcript',
    });

    expect(capturedOpts?.timeoutMs).toBeGreaterThanOrEqual(20_000);
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

describe('listMeetingNotes serialization — EM-05: the panel must see the same approval state as the tab/Library/Share dialog', () => {
  // Prod 2026-09-08 (EM-05, "Capiro Walktrhough" meeting): the Notes panel
  // showed "Draft" + an enabled Approve button for a note the DB had as
  // `approved`, while the tab dot, Meeting Library, and Share dialog all said
  // Approved. Root cause: this serializer dropped status/approvedAt/
  // approvedByUserId/sharedAt/sharedByUserId, so the client's
  // MeetingNoteStatus was always undefined and NotesTab's pill fell through
  // to "Draft". The web unit tests never caught it because they mock the API
  // response WITH status present. This spec pins the wire contract to the
  // real serializer so the four surfaces can never silently diverge again.
  const noteRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'n1',
    meetingId: 'm1',
    clientId: null,
    bodyCiphertext: 'ct',
    iv: 'iv',
    authTag: 'tag',
    keyVersion: 'v1',
    // Non-confidential + author-is-caller so canReadEncryptedEntry passes and
    // the decrypt path is exercised (the stub below decrypts to a fixed body).
    confidential: false,
    accessLevel: 'tenant_admins_and_author',
    authorUserId: 'user-1',
    author: { id: 'user-1', email: 'a@b.c', firstName: 'A', lastName: 'B' },
    createdAt: new Date('2026-09-08T19:39:32.912Z'),
    updatedAt: new Date('2026-09-08T19:39:36.793Z'),
    ...overrides,
  });

  function listService(rows: Array<Record<string, unknown>>) {
    return serviceWith(
      {
        meeting: { findFirst: async () => ({ id: 'm1' }) },
        meetingNote: { findMany: async () => rows },
      },
      {
        notesCrypto: {
          encrypt: () => ({ bodyCiphertext: 'ct', iv: 'iv', authTag: 'tag', keyVersion: 'v1' }),
          decrypt: () => 'decrypted note body',
        },
      },
    );
  }

  test('an approved note is serialized with its approval lifecycle fields — never flattened to Draft', async () => {
    const approvedAt = new Date('2026-09-08T19:39:36.802Z');
    const service = listService([
      noteRow({
        status: 'approved',
        approvedAt,
        approvedByUserId: 'user-1',
        sharedAt: null,
        sharedByUserId: null,
      }),
    ]);

    const serialized = (await service.listMeetingNotes(ctx, 'm1'))[0]!;

    expect(serialized.status).toBe('approved');
    expect(serialized.approvedAt).toBe(approvedAt);
    expect(serialized.approvedByUserId).toBe('user-1');
    expect(serialized.sharedAt).toBeNull();
    expect(serialized.sharedByUserId).toBeNull();
    expect(serialized.body).toBe('decrypted note body');
    expect(serialized.restricted).toBe(false);
  });

  test('a draft note serializes status "draft" and unstamped approval fields — the panel pill and Approve button then reflect the real state', async () => {
    const service = listService([
      noteRow({
        status: 'draft',
        approvedAt: null,
        approvedByUserId: null,
        sharedAt: null,
        sharedByUserId: null,
      }),
    ]);

    const serialized = (await service.listMeetingNotes(ctx, 'm1'))[0]!;

    expect(serialized.status).toBe('draft');
    expect(serialized.approvedAt).toBeNull();
    expect(serialized.approvedByUserId).toBeNull();
    expect(serialized.sharedAt).toBeNull();
    expect(serialized.sharedByUserId).toBeNull();
  });

  test('a shared approved note carries sharedAt/sharedByUserId so the pill can show Shared over Approved', async () => {
    const sharedAt = new Date('2026-09-08T20:00:00.000Z');
    const service = listService([
      noteRow({
        status: 'approved',
        approvedAt: new Date('2026-09-08T19:39:36.802Z'),
        approvedByUserId: 'user-1',
        sharedAt,
        sharedByUserId: 'user-2',
      }),
    ]);

    const serialized = (await service.listMeetingNotes(ctx, 'm1'))[0]!;

    expect(serialized.status).toBe('approved');
    expect(serialized.sharedAt).toBe(sharedAt);
    expect(serialized.sharedByUserId).toBe('user-2');
  });

  test('an edited note (approved then hand-edited) serializes status "edited" so the panel labels the re-approval state explicitly', async () => {
    const service = listService([
      noteRow({ status: 'edited', approvedAt: null, approvedByUserId: null }),
    ]);

    const serialized = (await service.listMeetingNotes(ctx, 'm1'))[0]!;

    expect(serialized.status).toBe('edited');
  });
});
