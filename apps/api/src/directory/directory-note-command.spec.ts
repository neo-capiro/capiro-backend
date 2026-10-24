import { beforeEach, describe, expect, it, jest } from '@jest/globals';
jest.mock('../clients/client-ordered-owner.access.js', () => ({ requireOwnerActor: jest.fn() }));
import { requireOwnerActor } from '../clients/client-ordered-owner.access.js';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import {
  commitMemberNote,
  memberNoteDigest,
  parseMemberNoteCommand,
  readMemberNoteReceipt,
} from './directory-note-command.js';

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000001',
  role: 'standard_user',
} as TenantContext;
const member = { id: 'member-42', name: 'Synthetic Member' };
const input = {
  schemaVersion: 1,
  requestId: '30000000-0000-4000-8000-000000000001',
  kind: 'note',
  directoryContactName: member.name,
  body: 'Reviewed the briefing.',
};
const command = parseMemberNoteCommand(member.id, input);
beforeEach(() => {
  jest.mocked(requireOwnerActor).mockReset();
});
function fixture() {
  const notes: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    directoryContactNote: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          notes.find((note) =>
            Object.entries(where).every(([key, value]) => note[key] === value),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          createdAt: new Date('2026-10-24T12:00:00Z'),
          createdBy: { id: data.createdByUserId, email: null, firstName: null, lastName: null },
        };
        notes.push(row);
        return row;
      }),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const current = jest.fn(async () => member);
  return {
    tx,
    current,
    commit: (value = command, actor = ctx) =>
      commitMemberNote(tx as unknown as Prisma.TransactionClient, actor, member.id, value, current),
    read: (actor = ctx, memberId = member.id) =>
      readMemberNoteReceipt(
        tx as unknown as Prisma.TransactionClient,
        actor,
        memberId,
        command.requestId,
      ),
  };
}
describe('Directory member note commands', () => {
  it('current authority loss refuses both commit and historical readback', async () => {
    const f = fixture();
    jest.mocked(requireOwnerActor).mockRejectedValue(new Error('Current membership revoked'));
    await expect(f.commit()).rejects.toThrow('revoked');
    await expect(f.read()).rejects.toThrow('revoked');
    expect(f.tx.directoryContactNote.create).not.toHaveBeenCalled();
    expect(f.tx.directoryContactNote.findFirst).not.toHaveBeenCalled();
  });
  it('commits once and recovers the exact immutable receipt after a lost response', async () => {
    const f = fixture();
    const saved = await f.commit();
    expect(saved).toMatchObject({
      schemaVersion: 1,
      requestId: command.requestId,
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      payloadDigest: memberNoteDigest(ctx, member.id, command),
      note: { id: command.requestId, directoryContactId: member.id, body: command.body },
    });
    expect(await f.commit()).toEqual(saved);
    expect(await f.read()).toEqual(saved);
    expect(f.tx.directoryContactNote.create).toHaveBeenCalledTimes(1);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.current).toHaveBeenCalledTimes(1);
  });
  it.each(['staff-42', '42', 'A000001', 'member-042', 'member-0'])(
    'rejects noncanonical member identity %s',
    (id) => {
      expect(() => parseMemberNoteCommand(id, input)).toThrow('canonical Directory member');
    },
  );
  it.each([
    { kind: 'call' },
    { body: '' },
    { body: 'x'.repeat(4001) },
    { staffId: 'staff-42' },
    { clientId: ctx.tenantId },
    { schemaVersion: 2 },
  ])('refuses unsupported or malformed commands', (patch) => {
    expect(() => parseMemberNoteCommand(member.id, { ...input, ...patch })).toThrow(
      'Review the Directory note',
    );
  });
  it('refuses missing or renamed canonical members before any write', async () => {
    const f = fixture();
    f.current.mockResolvedValueOnce({ ...member, id: 'member-99' });
    await expect(f.commit()).rejects.toThrow('member changed');
    f.current.mockResolvedValueOnce({ ...member, name: 'Renamed member' });
    await expect(f.commit()).rejects.toThrow('member changed');
    expect(f.tx.directoryContactNote.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('same request cannot change payload or actor', async () => {
    const f = fixture();
    await f.commit();
    await expect(f.commit({ ...command, body: 'Changed note' })).rejects.toThrow(
      'different Directory note',
    );
    await expect(
      f.commit(command, { ...ctx, userId: '20000000-0000-4000-8000-000000000002' }),
    ).rejects.toThrow('different Directory note');
    expect(f.tx.directoryContactNote.create).toHaveBeenCalledTimes(1);
  });
  it('receipt lookup excludes another tenant, actor and member', async () => {
    const f = fixture();
    await f.commit();
    await expect(
      f.read({ ...ctx, tenantId: '10000000-0000-4000-8000-000000000002' }),
    ).rejects.toThrow('unavailable');
    await expect(
      f.read({ ...ctx, userId: '20000000-0000-4000-8000-000000000002' }),
    ).rejects.toThrow('unavailable');
    await expect(f.read(ctx, 'member-99')).rejects.toThrow('unavailable');
  });
  it('receipt absence stays unavailable and readback never creates a note', async () => {
    const f = fixture();
    await expect(f.read()).rejects.toThrow('unavailable');
    expect(f.tx.directoryContactNote.create).not.toHaveBeenCalled();
    expect(f.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
