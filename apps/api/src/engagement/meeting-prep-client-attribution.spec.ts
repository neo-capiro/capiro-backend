import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import { resolvePrepClientId } from './engagement-access.helpers.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const grounding = {
  version: 1,
  sources: [],
  references: [],
  attendees: [],
  limitations: [],
  contentEdited: false,
};

/**
 * WP1 — legacy prep attribution.
 *
 * A prep row can carry client_id = NULL while its meeting belongs to a client. That
 * made the row permanently read-only in the UI: the write preserved the null stamp and
 * the receipt check then failed. These cases pin the three pieces of the fix: the
 * shared resolver, the create sites, and the bind-on-write in updateMeetingPrep.
 */
function txWith(meeting: Record<string, unknown>, prep: Record<string, unknown> = {}) {
  const real = {
    id: 'm1',
    status: 'confirmed',
    clientId: 'c1',
    isInternal: false,
    associationSignals: null,
    attendees: [],
    ...meeting,
  };
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ id: 'm1' }]),
    meeting: {
      findFirst: jest.fn(async () => ({ ...real })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }) => Object.assign(real, data)),
    },
    client: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, name: 'Client' })) },
    mailThread: { findMany: jest.fn(async () => []) },
    engagementTask: { findMany: jest.fn(async () => []) },
    meetingPrep: {
      findFirst: jest.fn(async () => prep),
      update: jest.fn(async ({ data }) => ({ id: 'prep-1', ...prep, ...data })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }) => ({ id: 'prep-1', ...data })),
    },
  };
  return { tx, real };
}

function updateHarness(meeting: Record<string, unknown>, prep: Record<string, unknown>) {
  const { tx, real } = txWith(meeting, {
    id: 'prep-1',
    meetingId: 'm1',
    generatedFrom: null,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    status: 'edited',
    clientId: 'c1',
    ...prep,
  });
  const service = Object.create(EngagementService.prototype) as any;
  Object.assign(service, {
    prisma: { withTenant: async (_t: string, cb: (tx: unknown) => unknown) => cb(tx) },
  });
  return { service: service as EngagementService, tx, real };
}

describe('resolvePrepClientId — one rule for every prep create', () => {
  test('an explicitly supplied client always wins and needs no meeting read', async () => {
    const { tx } = txWith({});
    await expect(resolvePrepClientId(tx, 'tenant-1', 'm1', 'supplied')).resolves.toBe('supplied');
    expect(tx.meeting.findFirst).not.toHaveBeenCalled();
  });

  test('a null supplied stamp on a client-scoped meeting resolves to the meeting client', async () => {
    const { tx } = txWith({ clientId: 'c1' });
    await expect(resolvePrepClientId(tx, 'tenant-1', 'm1', null)).resolves.toBe('c1');
    expect(tx.meeting.findFirst).toHaveBeenCalledWith({
      where: { id: 'm1', tenantId: 'tenant-1' },
      select: { clientId: true, isInternal: true, associationSignals: true },
    });
  });

  test.each([
    ['a meeting with no client', { clientId: null }],
    ['an internal meeting', { clientId: 'c1', isInternal: true }],
    [
      'a manually unassigned meeting',
      { clientId: null, associationSignals: { manual: true } },
    ],
  ])('%s keeps a null stamp', async (_label, meeting) => {
    const { tx } = txWith(meeting);
    await expect(resolvePrepClientId(tx, 'tenant-1', 'm1', null)).resolves.toBeNull();
  });

  test('an unreadable meeting keeps a null stamp rather than guessing', async () => {
    const tx: any = { meeting: { findFirst: jest.fn(async () => null) } };
    await expect(resolvePrepClientId(tx, 'tenant-1', 'm1', null)).resolves.toBeNull();
  });
});

describe('create sites stamp the meeting client', () => {
  test('the generated prep is created with the meeting client, not a null stamp', async () => {
    const { tx } = txWith({ clientId: 'c1' });
    const service = Object.create(EngagementService.prototype) as any;
    Object.assign(service, {
      prisma: {
        withTenant: async (_t: string, cb: (tx: unknown) => unknown) => cb(tx),
        withTenantUser: async (_t: string, _u: string, cb: (tx: unknown) => unknown) => cb(tx),
      },
      ai: {
        generateMeetingPrep: jest.fn(async () => ({
          summary: 'Prep',
          agenda: [],
          talkingPoints: [],
          risks: [],
          followUps: [],
          emailEvidence: [],
          grounding,
          provider: 'openai',
          model: 'test',
        })),
      },
      association: {
        associate: jest.fn(async () => ({ clientId: 'c1', score: 1, reason: 'matched', signals: {} })),
      },
      directoryProfilesForMeeting: async () => [],
      loadUserVoiceBlock: async () => null,
      clientMeetingAssociationWhere: async () => ({ clientId: 'c1' }),
      clientMailThreadAssociationWhere: jest.fn(async () => ({ clientId: 'c1' })),
      recordAiUsage: async () => {},
    });

    const saved = await service.generateMeetingPrep(ctx, 'm1');

    expect(tx.meetingPrep.create).toHaveBeenCalledTimes(1);
    const data = tx.meetingPrep.create.mock.calls[0]![0].data;
    expect(data.clientId).toBe('c1');
    expect(saved.clientId).toBe('c1');
  });

  test('a prep created for a meeting without a client stays null', async () => {
    const { tx } = txWith({ clientId: null, associationSignals: { manual: true } });
    expect(await resolvePrepClientId(tx, 'tenant-1', 'm1', null)).toBeNull();
  });
});

describe('updateMeetingPrep binds a legacy unstamped row in the same write', () => {
  test('a null-stamp prep on a client-scoped meeting is stamped and the receipt matches', async () => {
    const h = updateHarness({ clientId: 'c1' }, { clientId: null });
    const updated = await h.service.updateMeetingPrep(ctx, 'prep-1', { summary: 'Edited' });

    const data = h.tx.meetingPrep.update.mock.calls[0]![0].data;
    expect(data.clientId).toBe('c1');
    // existing behaviour preserved in the same write
    expect(data.summary).toBe('Edited');
    expect(data.status).toBe('approved');
    expect(data.editedByUserId).toBe('user-1');
    // the returned row satisfies the stamp the frontend checks before enabling edit
    expect(updated.clientId).toBe('c1');
  });

  test('a second save leaves the stamp unchanged (no re-stamp of a bound row)', async () => {
    const h = updateHarness({ clientId: 'c1' }, { clientId: 'c1', status: 'approved' });
    const updated = await h.service.updateMeetingPrep(ctx, 'prep-1', { summary: 'Edited again' });

    const data = h.tx.meetingPrep.update.mock.calls[0]![0].data;
    expect('clientId' in data).toBe(false);
    expect(updated.clientId).toBe('c1');
  });

  test('a prep already stamped to another client is not silently re-stamped', async () => {
    const h = updateHarness({ clientId: 'c1' }, { clientId: 'c2', status: 'approved' });
    const updated = await h.service.updateMeetingPrep(ctx, 'prep-1', { summary: 'Edited' });

    const data = h.tx.meetingPrep.update.mock.calls[0]![0].data;
    expect('clientId' in data).toBe(false);
    expect(updated.clientId).toBe('c2');
  });

  test('a meeting with no client keeps the null stamp and the row readable as before', async () => {
    const h = updateHarness(
      { clientId: null, associationSignals: { manual: true } },
      { clientId: null },
    );
    const updated = await h.service.updateMeetingPrep(ctx, 'prep-1', { summary: 'Edited' });

    const data = h.tx.meetingPrep.update.mock.calls[0]![0].data;
    expect('clientId' in data).toBe(false);
    expect(updated.clientId).toBeNull();
  });
});
