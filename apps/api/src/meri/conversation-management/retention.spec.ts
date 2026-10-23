import { TRASH_MS } from './contract.js';
import { readConversationRetentionState } from './retention.js';
import { readManagedConversationMetadata } from './service.js';

// Synthetic Prisma transaction; no database, retention ledger or deletion effect.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1), actorId = id(2), conversationId = id(3), requestId = id(4), clientId = id(5);
const subject = { tenantId, conversationId };
const now = new Date('2026-10-23T00:00:00.000Z');
function fixture(client = false) {
  let row: any = { id: conversationId, tenantId, userId: actorId, clientId: client ? clientId : null,
    title: 'Never in retention facts', status: 'trashed', metadataRevision: 2n, archivedAt: null,
    trashedAt: now, restoreUntil: new Date(+now + TRASH_MS), updatedAt: now,
    bootstrapReceipt: { tenantId, actorUserId: actorId, conversationId, requestId,
      clientId: client ? clientId : null, scopeKind: client ? 'client' : 'general' } };
  const membership = jest.fn(async () => null as { id: string } | null);
  const wall = jest.fn(async () => null);
  const read = jest.fn(async (_input: unknown) => row);
  const tx = { tenantMembership: { findFirst: membership }, client: { findFirst: wall },
    clioConversation: { findFirst: read } };
  const withTenant = jest.fn(async (_tenant: string, work: (tx: any) => Promise<unknown>) => work(tx));
  return { prisma: { withTenant } as never, withTenant, membership, wall, read,
    get row() { return row; }, setRow(value: any) { row = value; } };
}

test.each([false, true])('exact explicit binding returns content-free facts independent of interactive membership (client=%s)', async client => {
  const f = fixture(client);
  const result = await readConversationRetentionState(f.prisma, subject);
  expect(result).toEqual({ version: 'meri.conversation-retention.v1', identity: { tenantId, conversationId,
    ownerActorId: actorId, bootstrapRequestId: requestId,
    scope: client ? { kind: 'client', clientId } : { kind: 'general', clientId: null } },
    status: 'trashed', revision: '2', trashedAt: now.toISOString(), restoreUntil: new Date(+now + TRASH_MS).toISOString() });
  expect(f.withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function));
  expect(f.membership).not.toHaveBeenCalled(); expect(f.wall).not.toHaveBeenCalled();
  const query = f.read.mock.calls[0]![0] as { where: unknown; select: Record<string, unknown> };
  expect(query.where).toEqual({ tenantId, id: conversationId });
  expect(query.select).not.toHaveProperty('title'); expect(JSON.stringify(result)).not.toContain('Never in retention facts');
  await expect(readManagedConversationMetadata(f.prisma, { tenantId, actorId }, conversationId)).rejects.toThrow('Current conversation access unavailable');
});

test('revoked client wall alone does not strand scheduled facts, but interactive metadata still refuses', async () => {
  const f = fixture(true); f.membership.mockResolvedValue({ id: 'synthetic' });
  await expect(readConversationRetentionState(f.prisma, subject)).resolves.toHaveProperty('identity.scope.clientId', clientId);
  expect(f.wall).not.toHaveBeenCalled();
  await expect(readManagedConversationMetadata(f.prisma, { tenantId, actorId }, conversationId)).rejects.toThrow('Chat not found');
  expect(f.wall).toHaveBeenCalledTimes(1);
});

const mutations: Array<[string, (row: any) => any]> = [
  ['missing row', () => null], ['legacy unbound', row => ({ ...row, bootstrapReceipt: null })],
  ['other conversation', row => ({ ...row, id: id(8) })], ['other tenant', row => ({ ...row, tenantId: id(8) })],
  ['binding tenant', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, tenantId: id(8) } })],
  ['binding actor', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, actorUserId: id(8) } })],
  ['binding conversation', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, conversationId: id(8) } })],
  ['tombstone', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, conversationId: null } })],
  ['client mismatch', row => ({ ...row, clientId })],
  ['null is not client', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, scopeKind: 'client' } })],
  ['unknown explicit kind', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, scopeKind: 'prospect' } })],
  ['malformed bootstrap identity', row => ({ ...row, bootstrapReceipt: { ...row.bootstrapReceipt, requestId: 'unknown' } })],
  ['negative revision', row => ({ ...row, metadataRevision: -1n })], ['malformed revision', row => ({ ...row, metadataRevision: '2' })],
  ['unknown status', row => ({ ...row, status: 'deleted' })], ['missing trash time', row => ({ ...row, trashedAt: null })],
  ['invalid time', row => ({ ...row, restoreUntil: new Date(NaN) })],
  ['shortened interval', row => ({ ...row, restoreUntil: new Date(+now + TRASH_MS - 1) })],
  ['extended interval', row => ({ ...row, restoreUntil: new Date(+now + TRASH_MS + 1) })],
  ['active with trash facts', row => ({ ...row, status: 'active' })],
  ['archive without timestamp', row => ({ ...row, status: 'archived', trashedAt: null, restoreUntil: null })],
];
test.each(mutations)('refuses %s instead of deriving retention authority', async (_name, mutate) => {
  const f = fixture(); f.setRow(mutate(f.row));
  await expect(readConversationRetentionState(f.prisma, subject)).rejects.toThrow('Conversation retention identity unavailable');
});
test.each(['active', 'archived'])('returns %s as facts only, without claiming purge eligibility', async status => {
  const f = fixture(); f.setRow({ ...f.row, status, trashedAt: null, restoreUntil: null, archivedAt: status === 'archived' ? now : null });
  await expect(readConversationRetentionState(f.prisma, subject)).resolves.toMatchObject({ status, trashedAt: null, restoreUntil: null });
});
test.each([null, { ...subject, actorId }, { ...subject, tenantId: 'invalid' }, { tenantId }])('rejects malformed or authority-bearing subject before querying', async input => {
  const f = fixture();
  await expect(readConversationRetentionState(f.prisma, input as never)).rejects.toThrow('Invalid retention subject');
  expect(f.withTenant).not.toHaveBeenCalled();
});
