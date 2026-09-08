import { describe, expect, jest, test } from '@jest/globals';
import { AssociationEntityType, Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as TenantContext;
type Row = Record<string, any>;

function harness(options: { clientId?: string | null; isInternal?: boolean; failOn?: string; missingClient?: boolean; missingMeeting?: boolean } = {}) {
  const meeting = {
    id: 'm1', tenantId: ctx.tenantId, clientId: 'client-a', isInternal: false,
    associationScore: 0.9, visibility: 'shared', sharedAt: new Date(), sharedByUserId: 'user-1',
    ...options,
  };
  const initialArtifact = {
    tenantId: ctx.tenantId, meetingId: 'm1', clientId: meeting.clientId,
    status: 'approved', sharedAt: new Date(), sharedByUserId: 'user-1',
    bodyCiphertext: 'preserved-encrypted-body', summary: 'Original approved prep',
    generatedFrom: { clientId: meeting.clientId, grounding: { version: 1 } },
    approvedAt: new Date(), approvedByUserId: 'user-1',
  };
  const state: Record<string, any> = {
    meeting,
    meetingPrep: [{ id: 'prep', ...initialArtifact }],
    meetingNote: [{ id: 'note', ...initialArtifact }],
    meetingDebrief: [{ id: 'debrief', ...initialArtifact }],
    engagementAttachment: [{ id: 'file', ...initialArtifact, indexedAt: new Date(), s3Key: 'unchanged-file-key' }],
    engagementTask: [{ id: 'task', ...initialArtifact }],
    meetingBotSession: [{ id: 'bot', ...initialArtifact }],
    chunks: ['file:0'], overrides: [],
  };
  const writes: Row[] = [];
  const events: string[] = [];
  const tx: Row = {
    $queryRaw: jest.fn(async () => { events.push('lock'); return [{ id: 'm1' }]; }),
    meeting: {
      findFirst: jest.fn(async (_args: Row) => { events.push('read'); return options.missingMeeting ? null : { ...state.meeting }; }),
      update: jest.fn(async ({ where, data }: Row) => {
        writes.push({ model: 'meeting', where, data });
        Object.assign(state.meeting, data);
        return { ...state.meeting };
      }),
    },
    client: { findFirst: jest.fn(async (args: Row) => options.missingClient ? null : ({ id: args.where.id })) },
    clientAssociationOverride: { create: jest.fn(async ({ data }: Row) => { state.overrides.push(data); return data; }) },
    $executeRawUnsafe: jest.fn(async (...args: unknown[]) => { writes.push({ model: 'chunks', args }); state.chunks = []; return 1; }),
  };
  for (const model of ['meetingPrep', 'meetingNote', 'meetingDebrief', 'engagementAttachment', 'engagementTask', 'meetingBotSession']) {
    tx[model] = {
      create: jest.fn(async ({ data }: Row) => { events.push('create'); const row = { id: `${model}-new`, ...data }; state[model].push(row); return row; }),
      findMany: jest.fn(async (_args: Row) => state[model].map((row: Row) => ({ ...row }))),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        if (options.failOn === model) throw new Error('child update failed');
        writes.push({ model, where, data });
        for (const row of state[model]) Object.assign(row, data);
        return { count: state[model].length };
      }),
    };
  }
  const withTenant = jest.fn(async (tenantId: string, fn: (tx: Row) => Promise<unknown>) => {
    expect(tenantId).toBe(ctx.tenantId);
    const snapshot = structuredClone(state);
    try { return await fn(tx); } catch (error) { Object.assign(state, snapshot); throw error; }
  });
  const index = jest.fn();
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    prisma: { withTenant },
    clientKb: { indexAttachmentFireAndForget: index },
    notesCrypto: { encrypt: () => ({ bodyCiphertext: 'ct', iv: 'iv', authTag: 'tag', keyVersion: 'v1' }) },
    decorateMeetings: async (_tx: unknown, _ctx: unknown, rows: unknown[]) => rows,
  });
  return { service, tx, state, writes, events, index, withTenant };
}

describe('meeting client reassignment', () => {
  test.each(['edit', 'override'])('%s moves every child, revokes sharing and rebuilds document evidence after commit', async (entrypoint) => {
    const h = harness();
    const before = structuredClone(h.state.meetingPrep[0]);
    if (entrypoint === 'edit') await h.service.updateMeeting(ctx, 'm1', { clientId: 'client-b' });
    else await h.service.overrideAssociation(ctx, { entityType: AssociationEntityType.meeting, entityId: 'm1', clientId: 'client-b' });

    expect(h.withTenant).toHaveBeenCalledTimes(1);
    expect(h.events.slice(0, 2)).toEqual(['lock', 'read']);
    expect(h.state.meeting).toMatchObject({ clientId: 'client-b', isInternal: false, visibility: 'private', sharedAt: null });
    for (const model of ['meetingPrep', 'meetingNote', 'meetingDebrief', 'engagementAttachment', 'engagementTask', 'meetingBotSession']) {
      expect(h.state[model][0].clientId).toBe('client-b');
      const write = h.writes.find((w) => w.model === model);
      expect(write?.where).toEqual({ tenantId: ctx.tenantId, meetingId: 'm1' });
    }
    for (const model of ['meetingPrep', 'meetingNote', 'meetingDebrief', 'engagementAttachment']) {
      expect(h.state[model][0]).toMatchObject({ sharedAt: null, sharedByUserId: null, status: 'approved' });
    }
    expect(h.state.meetingPrep[0].summary).toBe(before.summary);
    expect(h.state.meetingPrep[0].generatedFrom).toEqual(before.generatedFrom);
    expect(h.state.meetingNote[0].bodyCiphertext).toBe('preserved-encrypted-body');
    expect(h.state.engagementAttachment[0]).toMatchObject({ s3Key: 'unchanged-file-key', indexedAt: null });
    expect(h.state.chunks).toEqual([]);
    expect(h.tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.any(String), ctx.tenantId, 'client_doc_chunk', 'file', 'file:%');
    expect(h.index).toHaveBeenCalledWith(ctx.tenantId, 'file');
    expect(h.state.overrides[0]).toMatchObject({ previousClientId: 'client-a', clientId: 'client-b' });
  });

  test.each(['clear', 'internal'])('%s removes client attribution and sharing without deleting artifacts', async (mode) => {
    const h = harness();
    if (mode === 'clear') await h.service.updateMeeting(ctx, 'm1', { clientId: null });
    else await h.service.overrideAssociation(ctx, { entityType: AssociationEntityType.meeting, entityId: 'm1', internal: true });
    expect(h.state.meeting).toMatchObject({ clientId: null, isInternal: mode === 'internal', visibility: 'private' });
    expect(h.state.meeting.associationSignals.manual).toBe(true);
    for (const model of ['meetingPrep', 'meetingNote', 'meetingDebrief', 'engagementAttachment', 'engagementTask', 'meetingBotSession']) {
      expect(h.state[model][0].clientId).toBeNull();
    }
    expect(h.index).not.toHaveBeenCalled();
    expect(h.state.chunks).toEqual([]);
  });

  test('assigning an internal meeting makes the client association external again', async () => {
    const h = harness({ clientId: null, isInternal: true });
    await h.service.updateMeeting(ctx, 'm1', { clientId: 'client-b' });
    expect(h.state.meeting).toMatchObject({ clientId: 'client-b', isInternal: false });
  });

  test('saving the same client keeps existing approvals, sharing, and evidence', async () => {
    const h = harness();
    await h.service.updateMeeting(ctx, 'm1', { clientId: 'client-a', subject: 'Edited title' });
    expect(h.state.meeting.visibility).toBe('shared');
    expect(h.state.meetingPrep[0].sharedAt).toBeInstanceOf(Date);
    expect(h.state.chunks).toEqual(['file:0']);
    expect(h.index).not.toHaveBeenCalled();
  });

  test('concurrent A→B and A→A requests leave parent and every child at the final client', async () => {
    const h = harness();
    let lockTail = Promise.resolve();
    const releases: Array<() => void> = [];
    h.tx.$queryRaw.mockImplementation(async () => {
      const preceding = lockTail;
      lockTail = new Promise<void>((resolve) => { releases.push(resolve); });
      await preceding;
      return [{ id: 'm1' }];
    });
    h.withTenant.mockImplementation(async (_tenantId, fn) => {
      try { return await fn(h.tx); } finally { releases.shift()?.(); }
    });
    await Promise.all([
      h.service.updateMeeting(ctx, 'm1', { clientId: 'client-b' }),
      h.service.updateMeeting(ctx, 'm1', { clientId: 'client-a' }),
    ]);
    expect(h.state.meeting.clientId).toBe('client-a');
    for (const model of ['meetingPrep', 'meetingNote', 'meetingDebrief', 'engagementAttachment']) {
      expect(h.state[model][0].clientId).toBe('client-a');
    }
  });

  test('rejects another tenant client before changing any meeting or child', async () => {
    const h = harness({ missingClient: true });
    await expect(h.service.updateMeeting(ctx, 'm1', { clientId: 'foreign-client' })).rejects.toThrow('Client not found');
    expect(h.tx.client.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-client', tenantId: ctx.tenantId }, select: { id: true } });
    expect(h.writes).toEqual([]);
    expect(h.index).not.toHaveBeenCalled();
  });

  test('rejects an inaccessible meeting before inspecting its artifacts', async () => {
    const h = harness({ missingMeeting: true });
    await expect(h.service.updateMeeting(ctx, 'm1', { clientId: 'client-b' })).rejects.toThrow('Meeting not found');
    expect(h.tx.meeting.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: ctx.tenantId, OR: [{ createdByUserId: ctx.userId }, { connection: { createdByUserId: ctx.userId } }] });
    expect(h.writes).toEqual([]);
  });

  test('propagates a child failure through the transaction and never queues reindexing', async () => {
    const h = harness({ failOn: 'meetingDebrief' });
    const before = structuredClone(h.state);
    await expect(h.service.updateMeeting(ctx, 'm1', { clientId: 'client-b' })).rejects.toThrow('child update failed');
    expect(h.state).toEqual(before);
    expect(h.index).not.toHaveBeenCalled();
    expect(h.tx.clientAssociationOverride.create).not.toHaveBeenCalled();
  });

  test.each(['note', 'debrief'])('new %s locks and reads the canonical meeting before insertion', async (type) => {
    const h = harness({ clientId: 'client-b' });
    if (type === 'note') await h.service.createMeetingNote(ctx, 'm1', { body: 'New notes' });
    else await h.service.createMeetingDebrief(ctx, 'm1', { body: 'New debrief' });
    expect(h.events).toEqual(['lock', 'read', 'create']);
    const model = type === 'note' ? 'meetingNote' : 'meetingDebrief';
    expect(h.state[model][1].clientId).toBe('client-b');
  });

  test.each(['confirm', 'buffer'])('late %s attachment uses current cleared client instead of stale upload input', async (kind) => {
    const h = harness({ clientId: null });
    Object.assign(h.service, {
      bucket: 'bucket',
      validateAttachmentParents: async () => undefined,
      s3: { send: async () => ({ ContentLength: 4 }) },
      readAttachmentBytes: async () => Buffer.from('test'),
      attachmentContent: { sha256: () => 'digest', detectContentType: () => 'text/plain', contentTypeConflicts: () => false },
      scanner: { getStatus: async () => 'clean', providerName: 'scanner' },
    });
    const input = { clientId: 'stale-client-a', meetingId: 'm1', fileName: 'notes.txt', contentType: 'text/plain' };
    if (kind === 'confirm') {
      await h.service.confirmAttachment(ctx, { ...input, s3Key: `tenants/${ctx.tenantId}/engagement/file/notes.txt` });
    } else {
      await h.service.createAttachmentFromBuffer(ctx, { ...input, buffer: Buffer.from('test') });
    }
    expect(h.events).toEqual(['lock', 'read', 'create']);
    expect(h.state.engagementAttachment[1].clientId).toBeNull();
    expect(h.index).not.toHaveBeenCalled();
  });
});

describe('canonical meeting client reads', () => {
  test('client debrief reads use the current parent even when a historical child has stale attribution', async () => {
    const h = harness();
    h.tx.meetingDebrief.findMany.mockResolvedValue([{ ...h.state.meetingDebrief[0], meetingId: 'm1', confidential: true, accessLevel: 'tenant_admins_and_author', authorUserId: 'someone-else', meeting: { id: 'm1', clientId: 'client-b' } }]);
    const results = await h.service.listClientDebriefs(ctx, { clientId: 'client-b', recipientEmails: ['old-client@example.com'] });
    expect(h.tx.meetingDebrief.findMany.mock.calls[0][0].where.OR).toEqual([{ meeting: { clientId: 'client-b' } }]);
    expect(results[0]?.clientId).toBe('client-b');
  });
  test.each([
    { clientId: 'client-b', isInternal: false, associationSignals: {}, expected: 'client-b' },
    { clientId: null, isInternal: true, associationSignals: {}, expected: null },
    { clientId: null, isInternal: false, associationSignals: { manual: true }, expected: null },
  ])('prep/debrief generation respects $clientId internal=$isInternal', async ({ expected, ...meeting }) => {
    const h = harness();
    const associate = jest.fn(async () => ({ clientId: 'wrong-client' }));
    Object.assign(h.service, { association: { associate } });
    const resolve = (h.service as any).resolveEffectiveMeetingClientId.bind(h.service);
    expect(await resolve(h.tx, ctx, { id: 'm1', attendees: [], ...meeting })).toBe(expected);
    expect(associate).not.toHaveBeenCalled();
  });

  test('email inference is restricted to unassigned, non-internal meetings without a manual clear', async () => {
    const h = harness();
    Object.assign(h.service, { clientProfileEmails: async () => ['client@example.com'] });
    const where = await (h.service as any).clientMeetingAssociationWhere(h.tx, ctx.tenantId, 'client-b');
    expect(where.OR[0]).toEqual({ clientId: 'client-b' });
    expect(where.OR[1]).toMatchObject({ clientId: null, isInternal: false });
    expect(where.OR[1].AND[0].OR).toEqual([
      { associationSignals: { path: ['manual'], equals: Prisma.AnyNull } },
      { associationSignals: { path: ['manual'], equals: false } },
    ]);
  });
});
