import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { ResolvedRole } from '../collaborators/role-policy.js';
import { EditLockService, LOCK_INACTIVITY_MS } from './edit-lock.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const editing = ['acquire', 'heartbeat', 'request', 'takeOver'] as const;
const operations = ['status', 'release', ...editing] as const;
type Operation = typeof operations[number];
type Lock = {
  draftId: string; tenantId: string; holderId: string; holderName: string;
  acquiredAt: Date; lastHeartbeatAt: Date; requestedById: string | null;
  requestedByName: string | null; requestedAt: Date | null;
};

function fixture(role: ResolvedRole = 'owner', recipientRole: ResolvedRole = 'editor') {
  const state: { lock: Lock | null } = { lock: {
    draftId, tenantId, holderId: 'actor', holderName: 'Actor',
    acquiredAt: new Date(), lastHeartbeatAt: new Date(),
    requestedById: null, requestedByName: null, requestedAt: null,
  } };
  const prisma = {
    wsDraft: { findFirst: jest.fn(async () => ({ id: draftId, tenantId, prospectId: null })) },
    wsEditLock: {
      findFirst: jest.fn(async () => state.lock),
      create: jest.fn(async ({ data }: { data: Partial<Lock> }) => {
        state.lock = {
          draftId, tenantId, holderId: 'actor', holderName: 'Actor',
          acquiredAt: new Date(), lastHeartbeatAt: new Date(),
          requestedById: null, requestedByName: null, requestedAt: null, ...data,
        };
        return state.lock;
      }),
      update: jest.fn(async ({ data }: { data: Partial<Lock> }) => {
        if (!state.lock) throw new Error('No lock');
        state.lock = { ...state.lock, ...data };
        return state.lock;
      }),
      delete: jest.fn(async () => { const prior = state.lock; state.lock = null; return prior; }),
    },
  };
  const collaborators = new CollaboratorsService(prisma as never, {} as never);
  jest.spyOn(collaborators, 'resolveRole').mockImplementation(async (_tenant, _draft, actor) =>
    actor === 'recipient' ? recipientRole : role,
  );
  const service = new EditLockService(prisma as never, collaborators);
  const run = (operation: Operation) => {
    switch (operation) {
      case 'acquire': return service.acquire(tenantId, draftId, 'actor', 'Actor');
      case 'request': return service.request(tenantId, draftId, 'actor', 'Actor');
      case 'takeOver': return service.takeOver(tenantId, draftId, 'actor', 'Actor');
      case 'heartbeat': return service.heartbeat(tenantId, draftId, 'actor');
      case 'release': return service.release(tenantId, draftId, 'actor');
      case 'status': return service.status(tenantId, draftId, 'actor');
    }
  };
  return { state, prisma, run };
}

function expectNoLockAccess(h: ReturnType<typeof fixture>) {
  expect(h.prisma.wsEditLock.findFirst).not.toHaveBeenCalled();
  expect(h.prisma.wsEditLock.create).not.toHaveBeenCalled();
  expect(h.prisma.wsEditLock.update).not.toHaveBeenCalled();
  expect(h.prisma.wsEditLock.delete).not.toHaveBeenCalled();
}

describe('EditLockService draft authority', () => {
  it.each(operations)('%s returns 404 to an unrelated tenant member before lock access', async operation => {
    const h = fixture(null);
    await expect(h.run(operation)).rejects.toMatchObject({ status: 404 });
    expectNoLockAccess(h);
  });

  describe.each(['reviewer', 'commenter', 'viewer'] as const)('%s role', role => {
    it.each(editing)('cannot %s or inspect the lock through that mutation', async operation => {
      const h = fixture(role);
      await expect(h.run(operation)).rejects.toMatchObject({ status: 403 });
      expectNoLockAccess(h);
    });
    it('can inspect and release its own lock after losing the edit role', async () => {
      const h = fixture(role);
      expect(await h.run('status')).toMatchObject({ heldByMe: true });
      expect(await h.run('release')).toMatchObject({ held: false, holderId: null });
      expect(h.prisma.wsEditLock.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe.each(['owner', 'editor'] as const)('%s role', role => {
    it.each(editing)('can %s without changing the existing lock protocol', async operation => {
      const h = fixture(role);
      if (operation === 'acquire') h.state.lock = null;
      if (operation === 'request') h.state.lock!.holderId = 'other-editor';
      if (operation === 'takeOver') {
        h.state.lock!.holderId = 'other-editor';
        h.state.lock!.lastHeartbeatAt = new Date(Date.now() - LOCK_INACTIVITY_MS - 1000);
      }
      const result = await h.run(operation);
      expect(operation === 'request' ? result.requestedById : result.holderId).toBe('actor');
    });
  });

  it.each(['heartbeat', 'release'] as const)('%s by an authorized non-holder does not mutate the lock', async operation => {
    const h = fixture('editor'); h.state.lock!.holderId = 'other-editor';
    expect(await h.run(operation)).toMatchObject({ holderId: 'other-editor', heldByMe: false });
    expect(h.prisma.wsEditLock.update).not.toHaveBeenCalled();
    expect(h.prisma.wsEditLock.delete).not.toHaveBeenCalled();
  });

  it.each([null, 'reviewer', 'commenter', 'viewer'] as const)('clears a pending handoff when recipient role is %s', async role => {
    const h = fixture('owner', role);
    Object.assign(h.state.lock!, { requestedById: 'recipient', requestedByName: 'Recipient' });
    expect(await h.run('release')).toMatchObject({ held: false, holderId: null });
    expect(h.prisma.wsEditLock.update).not.toHaveBeenCalled();
    expect(h.prisma.wsEditLock.delete).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'editor'] as const)('preserves handoff to an eligible %s', async role => {
    const h = fixture('owner', role);
    Object.assign(h.state.lock!, { requestedById: 'recipient', requestedByName: 'Recipient' });
    expect(await h.run('release')).toMatchObject({ holderId: 'recipient', requestedById: null });
    expect(h.prisma.wsEditLock.delete).not.toHaveBeenCalled();
  });
});
