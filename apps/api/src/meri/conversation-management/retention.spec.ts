import { MANAGEMENT_VERSION, TRASH_MS, managementDigest } from './contract.js';
import { readConversationRetentionState, finalizeConversationRetention } from './retention.js';
import { readManagedConversationMetadata } from './service.js';

// Synthetic Prisma transaction; no database, retention ledger or deletion effect.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1), actorId = id(2), conversationId = id(3), requestId = id(4), clientId = id(5), trashRequestId = id(6);
const subject = { tenantId, conversationId };
const now = new Date('2026-10-23T00:00:00.000Z');
function fixture(client = false) {
  let row: any = { id: conversationId, tenantId, userId: actorId, clientId: client ? clientId : null,
    title: 'Never in retention facts', status: 'trashed', metadataRevision: 2n, archivedAt: now,
    trashedAt: now, restoreUntil: new Date(+now + TRASH_MS), updatedAt: now,
    bootstrapReceipt: { tenantId, actorUserId: actorId, conversationId, requestId,
      clientId: client ? clientId : null, scopeKind: client ? 'client' : 'general' } };
  const membership = jest.fn(async () => null as { id: string } | null);
  const wall = jest.fn(async () => null);
  const read = jest.fn(async (_input: unknown) => row);
  const command = { version: MANAGEMENT_VERSION, requestId: trashRequestId, conversationId, expectedRevision: '1', operation: 'trash' as const };
  const receiptRows = [{ tenantId, actorUserId: actorId, requestId: trashRequestId, conversationId,
    requestSha256: managementDigest(command), receipt: { releaseRetention: false, suppressionRequestId: null,
      receipt: { version: MANAGEMENT_VERSION, requestId: trashRequestId, conversation: {
        conversationId, status: 'trashed', revision: '2', scopeKind: client ? 'client' : 'general',
        clientId: client ? clientId : null, trashedAt: now.toISOString(), restoreUntil: new Date(+now + TRASH_MS).toISOString() } } } }];
  const receipts = jest.fn(async () => receiptRows as any[]);
  const clock = jest.fn(async () => [{ now }]);
  const query = async (sql: TemplateStringsArray) => {
    const text = sql.join('');
    if (text.includes('pg_catalog.pg_attribute')) return [
      ['tenant_id','uuid',-1,true,false],['candidate_id','uuid',-1,true,false],
      ['candidate_sha256','bpchar',68,true,false],['proposer_user_id','uuid',-1,true,false],
      ['review_id','uuid',-1,true,false],['created_at','timestamptz',6,true,true],
    ].map(([columnName,typeName,typeModifier,notNull,hasDefault]) => ({ columnName,typeName,typeModifier,notNull,hasDefault,
      relationKind:'r',persistence:'p',rowSecurityEnabled:true,rowSecurityForced:true,hasChildren:false,builtInType:true }));
    if (text.includes('FROM memory_candidate') || text.includes('FROM clio_meri_memory_submissions')) return [];
    return clock();
  };
  const lock = jest.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1);
  const consumed = jest.fn(async () => receiptRows[0] as any);
  const erase = jest.fn(async () => { row = null; (receiptRows[0] as any).conversationId = null;
    (receiptRows[0] as any).receipt = { tombstone: true }; return { count: 1 }; });
  const tx = { tenantMembership: { findFirst: membership }, client: { findFirst: wall },
    clioConversation: { findFirst: read, deleteMany: erase }, clioConversationManagementReceipt: { findMany: receipts, findUnique: consumed },
    $queryRaw: query, $executeRaw: lock };
  const withTenant = jest.fn(async (_tenant: string, work: (tx: any) => Promise<unknown>) => work(tx));
  const withSystem = jest.fn(async (work: (tx: any) => Promise<unknown>) => withTenant(tenantId, work));
  return { prisma: { withTenant, withSystem } as never, withTenant, membership, wall, read, receipts, receiptRows, clock, lock, consumed, erase,
    get row() { return row; }, setRow(value: any) { row = value; } };
}

test.each([false, true])('exact explicit binding returns content-free facts independent of interactive membership (client=%s)', async client => {
  const f = fixture(client);
  const result = await readConversationRetentionState(f.prisma, subject);
  expect(result).toEqual({ version: 'meri.conversation-retention.v1', identity: { tenantId, conversationId,
    ownerActorId: actorId, bootstrapRequestId: requestId,
    scope: client ? { kind: 'client', clientId } : { kind: 'general', clientId: null } },
    status: 'trashed', revision: '2', trashedAt: now.toISOString(), restoreUntil: new Date(+now + TRASH_MS).toISOString(),
    trashRequestId, checkedAtMs: +now });
  expect(f.withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function));
  expect(f.membership).not.toHaveBeenCalled(); expect(f.wall).not.toHaveBeenCalled();
  const query = f.read.mock.calls[0]![0] as { where: unknown; select: Record<string, unknown> };
  expect(query.where).toEqual({ tenantId, id: conversationId });
  expect(query.select).not.toHaveProperty('title'); expect(JSON.stringify(result)).not.toContain('Never in retention facts');
  expect(f.lock.mock.invocationCallOrder[0]).toBeLessThan(f.read.mock.invocationCallOrder[0]!);
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
  ['archive without timestamp', row => ({ ...row, status: 'archived', archivedAt: null, trashedAt: null, restoreUntil: null })],
];
test.each(mutations)('refuses %s instead of deriving retention authority', async (_name, mutate) => {
  const f = fixture(); f.setRow(mutate(f.row));
  await expect(readConversationRetentionState(f.prisma, subject)).rejects.toThrow('Conversation retention identity unavailable');
});
test.each(['active', 'archived'])('returns %s as facts only, without claiming purge eligibility', async status => {
  const f = fixture(); f.setRow({ ...f.row, status, trashedAt: null, restoreUntil: null, archivedAt: status === 'archived' ? now : null });
  await expect(readConversationRetentionState(f.prisma, subject)).resolves.toMatchObject({ status, trashedAt: null, restoreUntil: null, trashRequestId: null });
  expect(f.receipts).not.toHaveBeenCalled();
});

test.each([
  ['absent', (rows: any[]) => []],
  ['ambiguous', (rows: any[]) => [rows[0], rows[0]]],
  ['wrong command', (rows: any[]) => [{ ...rows[0], requestSha256: 'a'.repeat(64) }]],
  ['wrong receipt identity', (rows: any[]) => [{ ...rows[0], requestId: id(9) }]],
  ['another generation', (rows: any[]) => { rows[0].receipt.receipt.conversation.revision = '3'; return rows; }],
  ['shorter deadline', (rows: any[]) => { rows[0].receipt.receipt.conversation.restoreUntil = now.toISOString(); return rows; }],
  ['release receipt', (rows: any[]) => { rows[0].receipt.releaseRetention = true; return rows; }],
] as const)('current Trash requires its exact immutable receipt: %s', async (_name, mutate) => {
  const f = fixture(); f.receipts.mockResolvedValue(mutate(f.receiptRows));
  await expect(readConversationRetentionState(f.prisma, subject)).rejects.toThrow('Conversation retention identity unavailable');
});

test('database-clock failure is unavailable, never replaced by a caller or process time', async () => {
  const f = fixture(); f.clock.mockResolvedValue([{ now: new Date(NaN) }]);
  await expect(readConversationRetentionState(f.prisma, subject)).rejects.toThrow('Conversation retention identity unavailable');
});

const finalization = { ...subject, ownerActorId: actorId, requestId: trashRequestId, revision: '2', restoreUntilMs: +now + TRASH_MS };
test('finalization uses Core clock and current Trash generation, then replays its consumed receipt without a second delete', async () => {
  const f = fixture();
  f.clock.mockResolvedValue([{ now: new Date(finalization.restoreUntilMs - 1) }]);
  await expect(finalizeConversationRetention(f.prisma, finalization)).rejects.toThrow('RETENTION_GENERATION_NOT_EXPIRED');
  expect(f.erase).not.toHaveBeenCalled();
  f.clock.mockResolvedValue([{ now: new Date(finalization.restoreUntilMs) }]);
  await expect(finalizeConversationRetention(f.prisma, finalization)).resolves.toMatchObject({ erased: true, replayed: false });
  await expect(finalizeConversationRetention(f.prisma, finalization)).resolves.toMatchObject({ erased: true, replayed: true });
  expect(f.erase).toHaveBeenCalledTimes(1);
  expect(f.lock.mock.calls[0]![0].join('')).toContain('LOCK TABLE memory_candidate');
  expect(f.lock.mock.calls[1]![0].join('')).toContain('FOR UPDATE');
});

test.each([
  { ...finalization, ownerActorId: id(9) }, { ...finalization, requestId: id(9) },
  { ...finalization, revision: '3' }, { ...finalization, restoreUntilMs: finalization.restoreUntilMs - 1 },
])('a mismatched finalization cannot erase the current row: %j', async input => {
  const f = fixture(); f.clock.mockResolvedValue([{ now: new Date(finalization.restoreUntilMs + 1000) }]);
  await expect(finalizeConversationRetention(f.prisma, input)).rejects.toThrow('RETENTION_GENERATION_NOT_EXPIRED');
  expect(f.erase).not.toHaveBeenCalled();
});

test('Restore before finalization refuses; an absent row without the exact consumed command is not successful erasure', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'active', metadataRevision: 3n, archivedAt: null, trashedAt: null, restoreUntil: null });
  await expect(finalizeConversationRetention(f.prisma, finalization)).rejects.toThrow('RETENTION_GENERATION_NOT_EXPIRED');
  f.setRow(null);
  await expect(finalizeConversationRetention(f.prisma, finalization)).rejects.toThrow('Conversation retention identity unavailable');
  expect(f.erase).not.toHaveBeenCalled();
});

test('lost Core commit acknowledgement is recovered by the same command and its actual tombstone', async () => {
  const f = fixture(); f.clock.mockResolvedValue([{ now: new Date(finalization.restoreUntilMs) }]);
  const committed = f.withTenant.getMockImplementation()!; let first = true;
  f.withTenant.mockImplementation(async (tenant, work) => { const result = await committed(tenant, work);
    if (first) { first = false; throw new Error('commit acknowledgement lost'); } return result; });
  await expect(finalizeConversationRetention(f.prisma, finalization)).rejects.toThrow('commit acknowledgement lost');
  await expect(finalizeConversationRetention(f.prisma, finalization)).resolves.toMatchObject({ erased: true, replayed: true });
  expect(f.erase).toHaveBeenCalledTimes(1);
  await expect(finalizeConversationRetention(f.prisma, { ...finalization, requestId: id(9) })).rejects.toThrow('Conversation retention identity unavailable');
});
test.each([null, { ...subject, actorId }, { ...subject, tenantId: 'invalid' }, { tenantId }])('rejects malformed or authority-bearing subject before querying', async input => {
  const f = fixture();
  await expect(readConversationRetentionState(f.prisma, input as never)).rejects.toThrow('Invalid retention subject');
  expect(f.withTenant).not.toHaveBeenCalled();
});
